package app

// 退出收尾（轮71）：窗口销毁之后进程必须真的退出去。
//
// 只要进程还活着，它的 exe 就被系统当作镜像加载着，Windows 安装程序覆盖前那道
// 「目标文件能不能写」的探针就永远过不去，用户看到的症状是「等待 ConfScope 退出」
// 无限打转（v1.9.9 线上）。隧道本身的行为在 internal/ssh 里用假 dialer 钉住了，
// 这一支钉的是 App 侧的接线：上限用没用、nil 会不会炸、超时了点没点名。

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"confscope/internal/ssh"
)

// shutdownLogRecorder 是 shutdownLogf 的内存替身：证明「点名的那条真的写出去了」，
// 而不会在单测里往真实数据根建目录、写文件。
type shutdownLogRecorder struct {
	mu    sync.Mutex
	lines []string
	roots []string
}

func (r *shutdownLogRecorder) capture(dataRoot string, line string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.roots = append(r.roots, dataRoot)
	r.lines = append(r.lines, line)
	return dataRoot
}

func (r *shutdownLogRecorder) all() ([]string, []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.lines...), append([]string(nil), r.roots...)
}

func captureShutdownLogLines(t *testing.T) *shutdownLogRecorder {
	t.Helper()

	recorder := &shutdownLogRecorder{}
	original := shutdownLogf
	shutdownLogf = recorder.capture
	t.Cleanup(func() { shutdownLogf = original })

	return recorder
}

func mustShutdownWithin(t *testing.T, budget time.Duration, app *App) {
	t.Helper()

	done := make(chan struct{})
	go func() {
		app.Shutdown(context.Background())
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(budget):
		t.Fatalf("Shutdown 在 %s 内没有返回：退出路径又被谁拖住了", budget)
	}
}

// 判红点：把 a.sshMgr.StopAllWithCeiling 换回 StopAll，或者删掉 nil 判定。
func TestShutdownIgnoresMissingSSHManagerAndReturnsPromptly(t *testing.T) {
	recorder := captureShutdownLogLines(t)

	mustShutdownWithin(t, 500*time.Millisecond, &App{})

	if lines, _ := recorder.all(); len(lines) != 0 {
		t.Fatalf("没有隧道时不该记任何退出诊断, got %v", lines)
	}
}

func TestShutdownReturnsPromptlyWithEmptyTunnelTable(t *testing.T) {
	recorder := captureShutdownLogLines(t)
	app := &App{sshMgr: ssh.NewManager(func() string { return "" })}

	mustShutdownWithin(t, 500*time.Millisecond, app)

	if lines, _ := recorder.all(); len(lines) != 0 {
		t.Fatalf("表是空的，不该有超时诊断, got %v", lines)
	}
	if got := app.ListActiveSSHTunnels(); len(got) != 0 {
		t.Fatalf("活动隧道 = %v, 期望退出收尾后为空", got)
	}
}

// 退出诊断必须点名到连接：用户报「装不上」时，日志里得看得出是谁拖住了退出。
func TestReportPendingTunnelsOnShutdownNamesConnections(t *testing.T) {
	recorder := captureShutdownLogLines(t)
	app := &App{sshMgr: ssh.NewManager(func() string { return "" })}

	app.reportPendingTunnelsOnShutdown([]string{"c_mqze3n5l_19oeti", "c_second"})

	lines, roots := recorder.all()
	if len(lines) != 1 {
		t.Fatalf("诊断行数 = %d, 期望一条", len(lines))
	}
	line := lines[0]
	for _, want := range []string{"c_mqze3n5l_19oeti", "c_second", "SSH", shutdownTunnelCeiling.String()} {
		if !strings.Contains(line, want) {
			t.Fatalf("退出诊断 %q 里没写进 %q", line, want)
		}
	}
	if !strings.Contains(line, "shutdown") {
		t.Fatalf("退出诊断 %q 少了类别前缀 shutdown（日志里要和启动解析分得开）", line)
	}
	if len(roots) != 1 || strings.TrimSpace(roots[0]) == "" {
		t.Fatalf("诊断必须写到数据根的日志目录里, got %v", roots)
	}
}

// 判红点：把 Shutdown 里那一脚换回无上限的 StopAll（变异5），这个用例必须炸。
// 它钉的是接线：退出收尾只允许走「带硬上限」的那一支，而且到点要把拖住退出的
// 连接名字落到日志里——用户报「装不上」时，那是唯一能看出是谁卡住的线索。
func TestShutdownUsesBoundedStopperAndNamesStuckConnections(t *testing.T) {
	recorder := captureShutdownLogLines(t)

	original := stopAllTunnelsOnShutdown
	var calls []time.Duration
	stopAllTunnelsOnShutdown = func(mgr *ssh.Manager, ceiling time.Duration) []string {
		if mgr == nil {
			t.Error("退出收尾不该把 nil 管理器交给停止接缝")
		}
		calls = append(calls, ceiling)
		return []string{"c_mqze3n5l_19oeti"}
	}
	t.Cleanup(func() { stopAllTunnelsOnShutdown = original })

	app := &App{sshMgr: ssh.NewManager(func() string { return "" })}
	mustShutdownWithin(t, 500*time.Millisecond, app)

	if len(calls) != 1 {
		t.Fatalf("退出收尾调用停止接缝 %d 次, 期望恰好一次（走了无上限的 StopAll 就是 0 次）", len(calls))
	}
	if calls[0] != shutdownTunnelCeiling {
		t.Fatalf("停止接缝的上限 = %s, 期望 %s", calls[0], shutdownTunnelCeiling)
	}

	lines, _ := recorder.all()
	if len(lines) != 1 || !strings.Contains(lines[0], "c_mqze3n5l_19oeti") {
		t.Fatalf("到点没停下时必须点名是哪条连接拖住退出, got %v", lines)
	}
}

// 上限存在且落在「装不上」可接受的量级：太短会真的掐断正常关闭，太长等于没有。
func TestShutdownTunnelCeilingIsBounded(t *testing.T) {
	if shutdownTunnelCeiling <= 0 || shutdownTunnelCeiling > 5*time.Second {
		t.Fatalf("shutdownTunnelCeiling = %s, 期望是 0 与 5s 之间的硬上限", shutdownTunnelCeiling)
	}
}

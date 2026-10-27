package portabledata

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const parkedExeBase = "ConfScope.exe"

func parkedLayout(dataRoot string) RuntimeLayout {
	return RuntimeLayout{Mode: RuntimeModeInstalled, DataRoot: dataRoot}
}

func TestIsParkedExecutableName(t *testing.T) {
	cases := []struct {
		name string
		got  string
		want bool
	}{
		{"普通让位副本", "ConfScope.exe.pending-1.9.18", true},
		{"带计数的让位副本", "ConfScope.exe.pending-1.9.18.2", true},
		{"当前 exe 自己", parkedExeBase, false},
		{"只有前缀没有版本号", "ConfScope.exe.pending-", false},
		{"别的 exe 的副本", "OtherApp.exe.pending-1.9.18", false},
		{"前缀相同但不是 exe 名", "ConfScope.pending-1.9.18", false},
		{"数据目录不许碰", "ConfScopeData", false},
		{"别人的备份不许碰", "ConfScope.exe.bak", false},
		{"跨版本的让位副本也要清", "ConfScope.exe.pending-10.0.0", true},
	}
	for _, testCase := range cases {
		if got := isParkedExecutableName(parkedExeBase, testCase.got); got != testCase.want {
			t.Fatalf("%s：isParkedExecutableName(%q) = %t，期望 %t", testCase.name, testCase.got, got, testCase.want)
		}
	}
}

// 非安装态一律不动手：便携版可能在 U 盘或别人的目录里，程序没资格在那儿删文件。
func TestCleanParkedExecutablesSkipsNonInstalledMode(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, parkedExeBase)
	writeParkedFile(t, exe, "exe")
	leftover := exe + ParkedExecutableSuffix + "1.9.18"
	writeParkedFile(t, leftover, "old")

	report := CleanParkedExecutables(RuntimeLayout{Mode: RuntimeModePortable, DataRoot: dir}, exe)
	if report.Swept {
		t.Fatalf("便携态不该扫程序目录：%+v", report)
	}
	if report.Reason == "" {
		t.Fatal("没扫也要留下原因，否则日志里看不出「为什么没动」")
	}
	if _, err := os.Stat(leftover); err != nil {
		t.Fatalf("便携态把遗留文件删了：%v", err)
	}
}

// 取不到绝对路径时必须当「不知道在哪」处理，绝不能拿占位路径去扫当前工作目录。
func TestCleanParkedExecutablesRejectsNonAbsolutePath(t *testing.T) {
	for _, exePath := range []string{"", "ConfScope.exe", filepath.Join(".", "ConfScope.exe")} {
		report := CleanParkedExecutables(parkedLayout(t.TempDir()), exePath)
		if report.Swept {
			t.Fatalf("相对/空路径 %q 居然扫了：%+v", exePath, report)
		}
		if report.Reason == "" {
			t.Fatalf("相对/空路径 %q 没留原因", exePath)
		}
	}
}

// exe 本身读不到 = 我们对这个目录一无所知，不删任何东西。
func TestCleanParkedExecutablesRequiresExistingExe(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, parkedExeBase)
	report := CleanParkedExecutables(parkedLayout(dir), missing)
	if report.Swept {
		t.Fatalf("exe 不存在还扫：%+v", report)
	}

	if err := os.MkdirAll(missing, 0o755); err != nil {
		t.Fatal(err)
	}
	if report := CleanParkedExecutables(parkedLayout(dir), missing); report.Swept {
		t.Fatalf("exe 路径是个目录还扫：%+v", report)
	}
}

func TestCleanParkedExecutablesClearsLeftoversOnly(t *testing.T) {
	dir := t.TempDir()
	dataRoot := filepath.Join(dir, "ConfScopeData")
	exe := filepath.Join(dir, parkedExeBase)
	writeParkedFile(t, exe, "new")

	first := exe + ParkedExecutableSuffix + "1.9.18"
	second := exe + ParkedExecutableSuffix + "1.9.18.2"
	writeParkedFile(t, first, "old-1")
	writeParkedFile(t, second, "old-2")

	// 三类不许碰的东西：数据目录、同名目录、别人的 exe 的副本。
	dataDir := filepath.Join(dir, DataDirName)
	if err := os.MkdirAll(filepath.Join(dataDir, AppDataDirName), 0o755); err != nil {
		t.Fatal(err)
	}
	keepData := filepath.Join(dataDir, AppDataDirName, AppDataDocFileName)
	writeParkedFile(t, keepData, "data")
	parkedDir := exe + ParkedExecutableSuffix + "9.9.9"
	if err := os.MkdirAll(parkedDir, 0o755); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(dir, "OtherApp.exe"+ParkedExecutableSuffix+"1.0.0")
	writeParkedFile(t, foreign, "foreign")
	// 指向别处的同名前缀链接：跟随删除会删到链接目标，属于「越界」，必须跳过。
	link := exe + ParkedExecutableSuffix + "0.0.1"
	linkTarget := filepath.Join(dir, "link-target.bin")
	writeParkedFile(t, linkTarget, "target")
	if err := os.Symlink(linkTarget, link); err != nil {
		t.Skipf("本机不支持符号链接：%v", err)
	}

	report := CleanParkedExecutables(parkedLayout(dataRoot), exe)
	if !report.Swept {
		t.Fatalf("安装态没扫：%+v", report)
	}
	if strings.Join(report.Cleared, ",") != "ConfScope.exe.pending-1.9.18,ConfScope.exe.pending-1.9.18.2" {
		t.Fatalf("清掉的东西不对：%+v", report.Cleared)
	}
	if len(report.Skipped) != 2 || !strings.Contains(strings.Join(report.Skipped, "|"), "同名目录") ||
		!strings.Contains(strings.Join(report.Skipped, "|"), "不是普通文件") {
		t.Fatalf("跳过的东西不对：%+v", report.Skipped)
	}
	for _, still := range []string{exe, keepData, parkedDir, foreign, linkTarget} {
		if _, err := os.Stat(still); err != nil {
			t.Fatalf("%s 不该被动：%v", still, err)
		}
	}
	for _, gone := range []string{first, second} {
		if _, err := os.Stat(gone); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s 应该已被清掉：%v", gone, err)
		}
	}

	// 自证据：扫过就必须往 data-root.log 留一行，否则「跑没跑」还是只能猜。
	logPath := filepath.Join(dataRoot, LogsDirName, RuntimeLogFileName)
	logged, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("没写行为日志：%v", err)
	}
	line := string(logged)
	if !strings.Contains(line, "parked-executables") || !strings.Contains(line, "cleared=2") || !strings.Contains(line, "skipped=2") {
		t.Fatalf("日志行不对：%s", line)
	}
}

// 删不掉（旧实例还攥着镜像、杀软扣住、只读挂载）不许变成错误，更不许中断扫描。
func TestSweepParkedEntriesSurvivesRemovalFailure(t *testing.T) {
	dir := t.TempDir()
	entries := []fs.DirEntry{
		fakeParkedEntry(parkedExeBase + ParkedExecutableSuffix + "1.0.0"),
		fakeParkedEntry(parkedExeBase + ParkedExecutableSuffix + "1.0.1"),
	}
	blocked := errors.New("另一个进程正在使用此文件")
	report := sweepParkedEntries(dir, parkedExeBase, entries, func(string) error { return blocked })
	if len(report.Cleared) != 0 {
		t.Fatalf("全被拦还报告清掉了：%+v", report.Cleared)
	}
	if len(report.Skipped) != 2 || !strings.Contains(report.Skipped[0], blocked.Error()) {
		t.Fatalf("如实上报删不掉的原因：%+v", report.Skipped)
	}

	// 混合场景：第一条删不掉，第二条照常删掉 —— 一条失败不许拖垮整次清扫。
	mixed := []fs.DirEntry{
		fakeParkedEntry(parkedExeBase + ParkedExecutableSuffix + "2.0.0"),
		fakeParkedEntry(parkedExeBase + ParkedExecutableSuffix + "2.0.1"),
	}
	report = sweepParkedEntries(dir, parkedExeBase, mixed, func(path string) error {
		if strings.HasSuffix(path, "2.0.0") {
			return blocked
		}
		return nil
	})
	if len(report.Cleared) != 1 || len(report.Skipped) != 1 {
		t.Fatalf("一条失败拖垮了整次清扫：%+v", report)
	}
}

func writeParkedFile(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fakeParkedEntry(name string) fs.DirEntry {
	return fakeDirEntry{name: name, mode: 0o644}
}

type fakeDirEntry struct {
	name string
	mode fs.FileMode
}

func (f fakeDirEntry) Name() string      { return f.name }
func (f fakeDirEntry) IsDir() bool       { return f.mode.IsDir() }
func (f fakeDirEntry) Type() fs.FileMode { return f.mode.Type() }
func (f fakeDirEntry) Info() (fs.FileInfo, error) {
	return fakeFileInfo{name: f.name, mode: f.mode}, nil
}

type fakeFileInfo struct {
	name string
	mode fs.FileMode
}

func (f fakeFileInfo) Name() string       { return f.name }
func (f fakeFileInfo) Size() int64        { return 0 }
func (f fakeFileInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (f fakeFileInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeFileInfo) Sys() any           { return nil }

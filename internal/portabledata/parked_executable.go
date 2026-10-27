package portabledata

// 安装程序「让位覆盖」留下的旧二进制副本（轮100）。
//
// 背景：Windows 上正在运行的 exe 删不掉，但改名改得掉 —— loader 打开 image section 时带
// FILE_SHARE_DELETE，VS Code 的 Code.exe.old、Inno Setup 的 RestartReplace 都靠这条语义。
// 所以安装程序等不到旧进程退出时，把 $INSTDIR\ConfScope.exe 改名成
// ConfScope.exe.pending-<版本号> 让开正位，新文件写在正位，全程不终止任何进程
// （红线：主数据是 debounce 落盘的，强杀等于吃掉最后一次写入）。
//
// 本文件负责另一头：那份改了名的旧副本，由应用下次启动时 best-effort 清掉。
//
// 与 NSIS 的唯一同源字面量是 ParkedExecutableSuffix ⇄ project.nsi 的 ${PARKED_SUFFIX}。
// 漂了不会有人立刻发现：名字对不上就永远清不掉遗留，而被占满的名字又会让下次让位失败，
// 守卫比对钉在 tests/ux/windowsInstallerKeepsDataAndMatchesRuntimeLayout.test.ts 的 C 组。

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// ParkedExecutableSuffix 是安装程序给让位副本加在 exe 名后面的前缀。
// 改它必须同时改 build/windows/installer/project.nsi 的 ${PARKED_SUFFIX}。
const ParkedExecutableSuffix = ".pending-"

// ParkedCleanupReport 是一次启动清扫的结果。best-effort：字段解释「做了什么」，
// 不代表失败 —— 清不掉是常态（旧实例还攥着那份镜像），不许因此影响启动。
type ParkedCleanupReport struct {
	// Swept = 真的遍历过 exe 同级目录。非安装态、拿不到 exe 路径、目录读不出来都是 false，
	// 区别必须留痕：「没扫」和「扫了但没有遗留」在日志里得看得出是两件事。
	Swept   bool
	ExeDir  string
	Cleared []string
	Skipped []string
	Reason  string
}

// isParkedExecutableName 判断目录项是不是指定 exe 的让位副本。
// 口径：同一个目录里、名字以「当前 exe 名 + 前缀」开头、且前缀后面还有内容（版本号）。
// 当前 exe 自己不算；只有前缀没有版本号的畸形名不算；别人的 exe 的副本更不算。
func isParkedExecutableName(exeBase string, name string) bool {
	if name == exeBase {
		return false
	}
	prefix := exeBase + ParkedExecutableSuffix
	return len(name) > len(prefix) && strings.HasPrefix(name, prefix)
}

// CleanParkedExecutables 清掉 exe 同级的让位遗留副本，并往行为日志记一行自证据。
//
// 只在安装态执行：便携态的 exe 可能在 U 盘、在别人的共享目录里，程序没资格在那种地方删文件。
// 删除是 best-effort，且两条已知的「删不动」都如实记进 Skipped 后继续：
//   - 旧实例还开着那份镜像：Windows 上删除会成功并把文件标成 delete-on-close，
//     旧进程不受影响，它退出时文件自己消失；真被扣死（杀软/网络盘）时这里就是删不掉，
//     那也只是一份旧副本躺在目录里，下次启动再试。
//   - 同名目录 / 读不到条目信息：不是我们要碰的东西，绝不递归删除。
func CleanParkedExecutables(layout RuntimeLayout, exePath string) ParkedCleanupReport {
	report := newParkedReport()
	if layout.Mode != RuntimeModeInstalled {
		report.Reason = "非安装态，不碰程序目录之外的位置"
		return report
	}
	if strings.TrimSpace(exePath) == "" || !filepath.IsAbs(exePath) {
		// 占位路径（取不到 exe 时的 "."）一律不当真：那会把当前工作目录当成程序目录扫。
		report.Reason = "取不到当前可执行文件的绝对路径，跳过清扫"
		return report
	}
	info, err := os.Stat(exePath)
	if err != nil || info.IsDir() {
		report.Reason = "当前可执行文件本身读不到，跳过清扫：" + errText(err)
		return report
	}
	exeDir := filepath.Dir(exePath)
	entries, readErr := os.ReadDir(exeDir)
	if readErr != nil {
		report.Reason = "程序目录读不出来，跳过清扫：" + readErr.Error()
		return report
	}
	report = sweepParkedEntries(exeDir, filepath.Base(exePath), entries, os.Remove)
	if !report.Swept {
		return report
	}
	// 只在真扫过的时候写日志：这条线的存在，是为了让「清扫到底跑没跑」变成可查事实，
	// 而不是每次启动都往日志里灌一行空气（非安装态根本不该有这行）。
	AppendRuntimeLogLine(layout.DataRoot, report.logLine())
	return report
}

// sweepParkedEntries 遍历目录项挑出让位副本并删除。删除动作可注入，
// 单测因此能在任何权限形态下（CI 跑 root 时 chmod 拦不住删除）覆盖「删不掉」这一支。
func sweepParkedEntries(exeDir string, exeBase string, entries []fs.DirEntry, remove func(string) error) ParkedCleanupReport {
	report := newParkedReport()
	report.ExeDir = exeDir
	report.Swept = true
	for _, entry := range entries {
		name := entry.Name()
		if !isParkedExecutableName(exeBase, name) {
			continue
		}
		path := filepath.Join(exeDir, name)
		if entry.IsDir() {
			report.Skipped = append(report.Skipped, name+"（同名目录，绝不递归删除）")
			continue
		}
		if info, err := entry.Info(); err != nil {
			report.Skipped = append(report.Skipped, name+"（读不到条目信息："+err.Error()+"）")
			continue
		} else if !info.Mode().IsRegular() {
			report.Skipped = append(report.Skipped, name+"（不是普通文件）")
			continue
		}
		if err := remove(path); err != nil {
			report.Skipped = append(report.Skipped, name+"（"+err.Error()+"）")
			continue
		}
		report.Cleared = append(report.Cleared, name)
	}
	return report
}

func newParkedReport() ParkedCleanupReport {
	return ParkedCleanupReport{Cleared: []string{}, Skipped: []string{}}
}

// logLine 是写进 data-root.log 的那一行。类别前缀与启动/退出诊断同一套口径。
func (r ParkedCleanupReport) logLine() string {
	return fmt.Sprintf("parked-executables\texeDir=%s\tcleared=%d\tclearedNames=%s\tskipped=%d\tskippedNames=%s",
		r.ExeDir, len(r.Cleared), joinOrDash(r.Cleared), len(r.Skipped), joinOrDash(r.Skipped))
}

func joinOrDash(items []string) string {
	if len(items) == 0 {
		return "-"
	}
	return strings.Join(items, " | ")
}

func errText(err error) string {
	if err == nil {
		return "无错误"
	}
	return err.Error()
}

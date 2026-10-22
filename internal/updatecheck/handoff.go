package updatecheck

// 交接出路：下载完产物之后，"装上去"这一步由谁做。
//
// 定调（2026-10-22，永久）：程序永不替换自己的二进制。过去这里写的是
// InstallAndRestart —— 往 %TEMP% 丢一个 bat/sh，隐藏进程轮询等旧进程死了再
// move 覆盖 exe，最后自己 del 掉自己。它把"何时可以覆盖二进制"这件本属于安装
// 程序的责任，交给一个用户看不见的进程，还要冒强杀数据写入的风险，整体删除。
// 现在这里只做三件事：起系统安装程序 / 打开下载位置 / 挂载 dmg，全部可见、可取消。

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// LaunchUpdateInstaller 起安装包。只有 Windows 安装版走这条路：
// 带 /UPDATE 让向导只留进度页，带 /PID 让安装程序有界等待"发起它的那个进程"退出
// （按 PID 而不是按进程名 —— U 盘里的便携版同名 exe 不该挡住本机升级）。
// 强杀一律禁止：主数据是 debounce 落盘的，被强杀等于吃掉最后一次写入。
func LaunchUpdateInstaller(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return errors.New("没有可安装的更新包")
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("更新包不存在或已被清理：%s", path)
	}
	if runtime.GOOS != "windows" {
		return errors.New("当前平台没有可由程序发起的安装程序，请按界面给出的手动步骤完成更新")
	}
	cmd := exec.Command(path, "/UPDATE", "/PID="+strconv.Itoa(os.Getpid()))
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动安装程序失败：%w", err)
	}
	// 不等它：本进程马上要优雅退出，安装程序会自己等旧进程死透
	return nil
}

// RevealDownloadedArtifact 打开下载位置并尽量选中该文件。
// 便携版/裸二进制/ tar.gz 的出路都是"人来覆盖"，所以这里只负责把文件摆到眼前。
func RevealDownloadedArtifact(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return errors.New("还没有下载好的更新包")
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("更新包不存在或已被清理：%s", path)
	}

	switch runtime.GOOS {
	case "windows":
		// explorer 的参数解析不归 Go 的 argv 引号管，路径带空格时选中可能失效，
		// 所以这里是尽力而为：界面同时显示完整路径供手工定位。
		_ = exec.Command("explorer.exe", fmt.Sprintf(`/select,"%s"`, path)).Start()
		return nil
	case "darwin":
		if err := exec.Command("open", "-R", path).Run(); err != nil {
			return fmt.Errorf("在 Finder 中显示文件失败：%w", err)
		}
		return nil
	default:
		if _, err := exec.LookPath("xdg-open"); err != nil {
			return errors.New("这个桌面环境没有可用的文件管理器，请按界面显示的完整路径手动打开")
		}
		// xdg-open 只认目录，选不中文件
		_ = exec.Command("xdg-open", filepath.Dir(path)).Start()
		return nil
	}
}

// AttachUpdateImage 挂载 macOS 的 dmg 并打开它的窗口，由人把 App 拖进 Applications。
// 不自动拖、不自动替换：那同样是"程序改自己的二进制"。
func AttachUpdateImage(path string) error {
	path = strings.TrimSpace(path)
	if path == "" {
		return errors.New("还没有下载好的更新镜像")
	}
	if runtime.GOOS != "darwin" {
		return errors.New("只有 macOS 需要挂载磁盘镜像，当前平台请按界面给出的手动步骤完成更新")
	}
	out, err := exec.Command("hdiutil", "attach", "-nobrowse", path).Output()
	if err != nil {
		return fmt.Errorf("挂载更新镜像失败：%w", err)
	}
	// hdiutil 最后一列是挂载点，例如 /Volumes/ConfScope
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	last := strings.Fields(lines[len(lines)-1])
	if len(last) < 3 {
		return errors.New("挂载成功但读不到卷标位置，请在 Finder 里打开新出现的 ConfScope 卷")
	}
	mount := strings.Join(last[2:], " ")
	if _, err := os.Stat(mount); err != nil {
		return fmt.Errorf("挂载点不存在：%s", mount)
	}
	if err := exec.Command("open", mount).Run(); err != nil {
		return fmt.Errorf("打开挂载卷失败，请手动打开 %s：%w", mount, err)
	}
	return nil
}

// InstallCommandFor 摆出包管理器命令。两条口径：
//  1. 命令只由「产物文件名的后缀 + 本机包格式」决定，前端不许自己拼 ——
//     拼错一条 sudo 命令让用户在终端里跑，比不更新更糟。
//  2. 只给命令，绝不代跑，也不提权。程序拿到 root 去覆盖自己装的位置
//     属于「程序改自己的二进制」的另一种写法，同样禁止。
func InstallCommandFor(artifactPath string, packageFormat string) string {
	artifactPath = strings.TrimSpace(artifactPath)
	if artifactPath == "" {
		return ""
	}
	format := strings.ToLower(strings.TrimSpace(packageFormat))
	if format == "" {
		switch strings.ToLower(filepath.Ext(artifactPath)) {
		case ".deb":
			format = "deb"
		case ".rpm":
			format = "rpm"
		}
	}
	switch format {
	case "deb":
		// apt 处理依赖；dpkg -i 在缺依赖时留下一个装一半的包
		return fmt.Sprintf(`sudo apt install "%s"`, artifactPath)
	case "rpm":
		// rpm -Uvh 各发行版都在；dnf/yum 未必
		return fmt.Sprintf(`sudo rpm -Uvh "%s"`, artifactPath)
	default:
		return ""
	}
}

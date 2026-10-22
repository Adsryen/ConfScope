package updatecheck

// 产物选择与交接出路。
//
// 为什么要有这个文件：manifest 的 platforms 里有 6~7 个条目，而"该拿哪一个"过去只由
// runtime.GOOS-GOARCH 决定（CurrentPlatform），后果是 linux-amd64-deb / -rpm 两条
// 永远是死条目 —— 用 deb 装上的人更新下来的是 tar.gz，装不回原位置。
// 现在选择按「平台 + 运行形态 + 安装方式」三件事算，运行形态直接复用
// internal/portabledata 的解析结果，不自造第二套判据。

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"confscope/internal/portabledata"
)

// Handoff 是"下载完成之后怎么装上去"。程序永不替换自己的二进制，
// 所以这里只有"交给别人"的几种方式，没有"自己动手"。
type Handoff string

const (
	// HandoffInstaller 起安装程序并由应用优雅退出（仅 Windows 安装版）。
	HandoffInstaller Handoff = "installer"
	// HandoffReveal 打开下载位置并选中文件，覆盖动作由人来做。
	HandoffReveal Handoff = "reveal"
	// HandoffCommand 摆出一条包管理器命令供复制，应用不提权也不代跑。
	HandoffCommand Handoff = "command"
	// HandoffImage 挂载 dmg 并打开 Finder，由人拖进 Applications。
	HandoffImage Handoff = "image"
	// HandoffPage 只打开 Release 下载页（manifest 里没有可用条目时的兜底出路）。
	HandoffPage Handoff = "page"
)

// InstallerPlatformKey 是 Windows 安装版的 manifest 条目键。
// 与 .github/workflows/release.yml 的 generate-manifest 保持一致。
const InstallerPlatformKey = "windows-amd64-installer"

// Selection 描述"这台机器现在该拿哪个条目"。
type Selection struct {
	Platform      string                   `json:"platform"`      // windows-amd64 / linux-amd64 / darwin-arm64 ...
	Mode          portabledata.RuntimeMode `json:"mode"`          // 空值按便携态处理（保守：拿裸产物 + 人工出路）
	PackageFormat string                   `json:"packageFormat"` // deb / rpm / ""，只在 Linux 上有意义
}

// CurrentSelection 组装选择输入。mode 必须来自 portabledata 的解析结果，
// packageFormat 由 DetectPackageFormat 提供；两者都不接受前端传值。
func CurrentSelection(mode portabledata.RuntimeMode, packageFormat string) Selection {
	return Selection{Platform: CurrentPlatform(), Mode: mode, PackageFormat: packageFormat}
}

// CandidateKeys 按优先级给出该依次尝试的 manifest 平台键。
func (s Selection) CandidateKeys() []string {
	base := s.Platform
	if base == "" {
		base = CurrentPlatform()
	}
	goos := base
	if i := strings.Index(base, "-"); i > 0 {
		goos = base[:i]
	}

	switch goos {
	case "windows":
		// 只有安装版才该拿安装包：便携版拿安装包等于让用户多跑一次安装程序，
		// 而它本来只需要覆盖一个 exe。
		if s.Mode == portabledata.RuntimeModeInstalled {
			return []string{InstallerPlatformKey, base}
		}
		return []string{base}
	case "linux":
		if s.PackageFormat == "deb" {
			return []string{base + "-deb", base}
		}
		if s.PackageFormat == "rpm" {
			return []string{base + "-rpm", base}
		}
		return []string{base}
	default:
		// darwin 的 base 条目本身就指向 .dmg，没有第二种形态可选。
		return []string{base}
	}
}

// SelectionResult 是选条目的结论，含出路。
type SelectionResult struct {
	Asset       PlatformAsset `json:"asset"`
	PlatformKey string        `json:"platformKey"`
	Handoff     Handoff       `json:"handoff"`
	Resolved    bool          `json:"resolved"`
	Downgraded  bool          `json:"downgraded"`
	Reason      string        `json:"reason,omitempty"`
}

// SelectAsset 在 manifest 里按选择顺序取第一个可用条目。
// 全都取不到时不报错、不崩，返回 HandoffPage 让 UI 回落"打开下载页"——
// 旧 tag 的 update.json 里没有 installer 条目，新客户端必须能优雅应对。
func SelectAsset(m Manifest, s Selection) SelectionResult {
	keys := s.CandidateKeys()
	for i, key := range keys {
		asset, ok := m.Platforms[key]
		if !ok || strings.TrimSpace(asset.DownloadURL) == "" {
			continue
		}
		res := SelectionResult{
			Asset:       normalizeAsset(asset, key),
			PlatformKey: key,
			Handoff:     handoffFor(s, key),
			Resolved:    true,
			Downgraded:  i > 0,
		}
		if res.Downgraded {
			// Reason 记录"本来更该拿哪个"，界面与守卫都靠它判断
			// 是旧 tag 缺条目还是选择逻辑算错了。
			res.Reason = "preferred-entry-missing:" + strings.Join(keys[:i], ",")
		}
		return res
	}

	// 再退一步：旧版单一 downloadUrl。出路给人工覆盖，不猜形态。
	if strings.TrimSpace(m.DownloadURL) != "" {
		return SelectionResult{
			Asset: PlatformAsset{
				DownloadURL: m.DownloadURL,
				SHA256:      m.SHA256,
				FileName:    filepath.Base(m.DownloadURL),
			},
			PlatformKey: "legacy",
			Handoff:     HandoffReveal,
			Resolved:    true,
			Downgraded:  true,
			Reason:      "legacy-manifest",
		}
	}

	return SelectionResult{PlatformKey: "none", Handoff: HandoffPage, Reason: "no-asset-for-platform"}
}

func normalizeAsset(asset PlatformAsset, key string) PlatformAsset {
	if strings.TrimSpace(asset.FileName) == "" {
		asset.FileName = filepath.Base(asset.DownloadURL)
	}
	if asset.FileName == "" || asset.FileName == "/" || asset.FileName == "." {
		asset.FileName = defaultFileName(key)
	}
	return asset
}

func defaultFileName(key string) string {
	switch key {
	case InstallerPlatformKey:
		return "confscope-windows-amd64-installer.exe"
	case "windows-amd64":
		return "ConfScope.exe"
	default:
		return "confscope-" + key
	}
}

// handoffFor 决定出路。规则：能安全交给安装程序的只有 Windows 安装版；
// mac 给 dmg 挂载；Linux 包管理器给命令；其余一律人工覆盖。
func handoffFor(s Selection, key string) Handoff {
	switch {
	case key == InstallerPlatformKey:
		return HandoffInstaller
	case strings.HasSuffix(key, "-deb") || strings.HasSuffix(key, "-rpm"):
		return HandoffCommand
	case strings.HasPrefix(key, "darwin"):
		return HandoffImage
	default:
		return HandoffReveal
	}
}

// DetectPackageFormat 判断当前 Linux 副本是不是包管理器装的（deb/rpm）。
// 非 Linux 恒返回 "" —— 否则会拿 deb 条目去更新一个 tar.gz 装的东西。
func DetectPackageFormat() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err == nil {
		exe = resolved
	}
	return detectPackageFormat(exe, fileExists, rpmInstalled)
}

// systemPrefixes 是"由包管理器放到系统目录"的特征路径。
// 与 portabledata.installedModeHintFromPath 的口径对齐（同一批落位）。
var systemPrefixes = []string{"/usr/bin/", "/usr/local/bin/", "/opt/"}

func underSystemPrefix(exePath string) bool {
	slash := filepath.ToSlash(exePath)
	for _, prefix := range systemPrefixes {
		if strings.HasPrefix(slash, prefix) {
			return true
		}
	}
	return false
}

func detectPackageFormat(exePath string, exists func(string) bool, query func(string) bool) string {
	if !underSystemPrefix(exePath) {
		return ""
	}
	// dpkg 的清单文件是最硬的证据
	if exists("/var/lib/dpkg/info/confscope.list") {
		return "deb"
	}
	if query("confscope") {
		return "rpm"
	}
	// rpm 命令不可用（容器里常见）但机器明显是 rpm 系：按 rpm 给命令，
	// 至少比退回 tar.gz 更接近原安装方式。
	if exists("/var/lib/rpm/Packages") || exists("/usr/lib/sysimage/rpm/Packages") {
		return "rpm"
	}
	return ""
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// rpmInstalled 跑 `rpm -q <name>`。查不到/命令不存在都返回 false，不panic。
func rpmInstalled(name string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, err := exec.LookPath("rpm"); err != nil {
		return false
	}
	return exec.CommandContext(ctx, "rpm", "-q", name).Run() == nil
}

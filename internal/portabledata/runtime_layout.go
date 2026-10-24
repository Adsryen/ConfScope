// Package portabledata 的数据根解析链（轮62 R1）。
//
// 这个文件是本机「数据落在哪」的唯一事实源：运行模式（portable/installed）与
// 数据根由同一次解析同时得出，任何消费方（更新出路分流、安装包、设置页展示、
// 审计目录、主数据文件路径）都不得再自己拼 "ConfScopeData"。
//
// 解析五档（顺序不可调换，见 .trellis/tasks/10-22-r62-data-root-resolver/prd.md）：
//  1. env          CONFSCOPE_DATA_DIR 显式覆盖（开发机/便携启动器语义不变）
//  2. user-choice  指针文件（OS 配置目录），产品内「更改位置」的持久化载体
//  3. install-marker exe 同级 install.json 标记 → OS 用户数据目录
//  4. legacy-adoption 采纳已有数据的根（老便携用户零迁移）
//  5. 兜底按可写性分流：exe 目录可写 → exe 同级；不可写 → OS 用户数据目录
package portabledata

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// RuntimeMode 是运行形态：决定「换版本走安装程序还是人工替换」，与数据根同级解析得出。
type RuntimeMode string

const (
	RuntimeModePortable  RuntimeMode = "portable"
	RuntimeModeInstalled RuntimeMode = "installed"
)

// RootSource 是数据根命中的档位名（进日志与设置页展示，便于用户自证「数据到底在哪」）。
type RootSource string

const (
	RootSourceEnv            RootSource = "env"
	RootSourceUserChoice     RootSource = "user-choice"
	RootSourceInstallMarker  RootSource = "install-marker"
	RootSourceLegacyAdoption RootSource = "legacy-adoption"
	RootSourceExeAdjacent    RootSource = "exe-adjacent"
	RootSourceOsUserData     RootSource = "os-user-data"
)

const (
	// AppDataDirName/AppDataDocFileName 是主数据文件在数据根内的相对位置（唯一声明处）。
	AppDataDirName     = "app-data"
	AppDataDocFileName = "confscope-data.json"
	// InstallMarkerFileName 由安装包写入 exe 同级，声明「本副本是安装态」。
	InstallMarkerFileName = "install.json"
	// PointerFileName 记录用户选择的根。放 OS 配置目录是因为它不能随数据根一起搬。
	PointerFileName = "data-root.json"
	// LogsDirName 是数据根下的日志目录（data-root.log 等）。
	LogsDirName = "logs"
	// RuntimeLogFileName 是日志目录里的自证据文件：启动时的数据根解析与退出时的
	// 收尾诊断都写在这里（AppendRuntimeLogLine）。设置页「日志」入口指向的就是这个目录。
	RuntimeLogFileName = "data-root.log"
	// MigrationJournalFileName 是迁移断点记录（幂等续跑用），以点开头避免被当数据条目展示。
	MigrationJournalFileName = ".confscope-migration.json"
	// PointerFileVersion 是指针文件 schema 版本。
	pointerFileVersion = 1
	// migratedMarkerPrefix 是旧根上留下的迁移标记（只写标记，绝不删数据）。
	MigratedMarkerPrefix = "MIGRATED-"
	// corruptFileSuffix 沿用主数据文件的「隔离不删」风格。
	corruptFileSuffix = ".corrupt-"
)

// RuntimeLayout 是一次数据根解析的完整结果。
type RuntimeLayout struct {
	Mode           RuntimeMode `json:"mode"`
	DataRoot       string      `json:"dataRoot"`
	Source         RootSource  `json:"source"`
	ExeDir         string      `json:"exeDir"`
	ExeDirWritable bool        `json:"exeDirWritable"`
	PointerPath    string      `json:"pointerPath"`
	PreviousRoot   string      `json:"previousRoot"`
	OsDataDir      string      `json:"osDataDir"`
	Notes          []string    `json:"notes"`
}

// InstallMarker 是 install.json 的内容，由安装包写入（本程序永不写它）。
type InstallMarker struct {
	Mode        string `json:"mode"`
	InstalledAt string `json:"installedAt"`
	Version     string `json:"version"`
}

// DataRootPointer 是用户选择数据根的指针文件内容。
type DataRootPointer struct {
	Version      int    `json:"version"`
	DataRoot     string `json:"dataRoot"`
	PreviousRoot string `json:"previousRoot"`
	UpdatedAt    string `json:"updatedAt"`
}

// MainDataDocPath 返回主数据文件在指定数据根下的绝对路径。
func MainDataDocPath(dataRoot string) string {
	return filepath.Join(dataRoot, AppDataDirName, AppDataDocFileName)
}

// layoutInput 是可注入的解析输入，便于单测覆盖五档而不碰真实 OS 目录。
type layoutInput struct {
	exePath       string
	lookupEnv     func(string) (string, bool)
	osDataDir     func() (string, error)
	pointerDir    func() (string, error)
	probeWritable func(string) bool
}

// resolveLayout 是纯逻辑解析（只读文件系统，不创建任何目录/文件）。
func resolveLayout(in layoutInput) (RuntimeLayout, error) {
	if in.lookupEnv == nil {
		in.lookupEnv = os.LookupEnv
	}
	if in.osDataDir == nil {
		in.osDataDir = OsUserDataDir
	}
	if in.pointerDir == nil {
		in.pointerDir = OsPointerDir
	}
	if in.probeWritable == nil {
		in.probeWritable = probeWritable
	}
	if strings.TrimSpace(in.exePath) == "" {
		return RuntimeLayout{}, errors.New("解析数据根失败：可执行文件路径为空")
	}

	exeDir := filepath.Dir(in.exePath)
	osDir, osDirErr := in.osDataDir()
	if osDirErr != nil {
		osDir = ""
	}
	pointerDir, pointerDirErr := in.pointerDir()
	if pointerDirErr != nil || strings.TrimSpace(pointerDir) == "" {
		pointerDir = ""
	}
	// 默认档位下指针目录与 OS 数据根不该重叠；重叠时（平台差异/大小写不敏感）把指针挪开，
	// 否则「把数据根迁到指针所在目录」会让指针文件被当成数据条目一起复制。
	if pointerDir != "" && osDir != "" && (pathsEqual(pointerDir, osDir) || isAncestorDir(osDir, pointerDir)) {
		pointerDir = filepath.Join(filepath.Dir(osDir), "ConfScopeRuntime")
	}

	marker, markerErr := readInstallMarker(exeDir)
	layout := RuntimeLayout{
		Mode:           resolveMode(exeDir, marker, markerErr),
		ExeDir:         exeDir,
		ExeDirWritable: in.probeWritable(exeDir),
		OsDataDir:      osDir,
		PointerPath:    pointerPathFor(pointerDir),
	}

	// 第 1 档：显式环境变量覆盖，语义与今天完全一致。
	if override := strings.TrimSpace(envValue(in, DataDirEnvName)); override != "" {
		layout.DataRoot = absolutize(override)
		layout.Source = RootSourceEnv
		return layout, nil
	}

	// 第 2 档：用户选择的根（指针文件）。损坏时隔离保留并继续往下解析，不崩。
	ptr, pointerQuarantine := readDataRootPointer(layout.PointerPath)
	if pointerQuarantine != "" {
		layout.Notes = append(layout.Notes, fmt.Sprintf("指针文件损坏，已隔离为 %s", pointerQuarantine))
	}
	if ptr != nil {
		if chosen := strings.TrimSpace(ptr.DataRoot); chosen != "" {
			if usableChosenRoot(chosen, in) {
				layout.DataRoot = absolutize(chosen)
				layout.Source = RootSourceUserChoice
				if previous := strings.TrimSpace(ptr.PreviousRoot); previous != "" {
					layout.PreviousRoot = absolutize(previous)
				}
				return layout, nil
			}
			layout.Notes = append(layout.Notes, fmt.Sprintf("指针记录的根 %s 不可用（不存在且无法创建），已回退自动解析", chosen))
		}
	}

	// 第 3 档：安装标记 → OS 用户数据目录（便携 zip 不带这个文件，便携行为一字不变）。
	if marker != nil && markerErr == nil && marker.Mode == string(RuntimeModeInstalled) {
		if osDir != "" {
			layout.DataRoot = osDir
			layout.Source = RootSourceInstallMarker
			return layout, nil
		}
		layout.Notes = append(layout.Notes, "检测到安装标记但取不到 OS 用户数据目录")
	}

	// 第 4 档：采纳已有数据的根。判据只看主数据文件是否存在且非空——
	// 判得越深（parse/schemaVersion）越容易在异常时把用户已有数据「判没」，
	// 那正是 2026-09-04 事故的形态。
	for _, candidate := range adoptionCandidates(exeDir, osDir) {
		if hasMainDataFile(candidate) {
			layout.DataRoot = candidate
			layout.Source = RootSourceLegacyAdoption
			if !layout.ExeDirWritable && pathsEqual(candidate, filepath.Join(exeDir, DataDirName)) {
				layout.Notes = append(layout.Notes, "采纳的旧根当前不可写，数据可见优先，写入可能失败")
			}
			return layout, nil
		}
	}

	// 第 5 档：兜底按可写性分流。exe 目录还不存在时按可写处理——那是裸二进制/
	// 开发链路（build/bin 尚未生成）的形态，与历史行为一致：建目录而不是改判到别处。
	if layout.ExeDirWritable || directoryMissing(exeDir) {
		layout.DataRoot = filepath.Join(exeDir, DataDirName)
		layout.Source = RootSourceExeAdjacent
		return layout, nil
	}
	if osDir != "" {
		layout.DataRoot = osDir
		layout.Source = RootSourceOsUserData
		layout.Notes = append(layout.Notes, "exe 同级目录不可写，数据根落到 OS 用户数据目录")
		return layout, nil
	}
	// 连 OS 目录都取不到时，宁可回到 exe 同级并留下明确诊断，也不要解析失败导致无根可用。
	layout.DataRoot = filepath.Join(exeDir, DataDirName)
	layout.Source = RootSourceExeAdjacent
	layout.Notes = append(layout.Notes, "取不到 OS 用户数据目录，回退 exe 同级 ConfScopeData")
	return layout, nil
}

// resolveMode 判定运行形态。安装标记是唯一事实源，路径启发式只作兜底且必须留痕。
// marker==nil 表示没有标记文件；err!=nil 表示标记存在但读不了（损坏/无权限），
// 两种情况都按便携态处理，不崩、不静默改数据根。
func resolveMode(exeDir string, marker *InstallMarker, err error) RuntimeMode {
	if err != nil || marker == nil {
		if err == nil && installedModeHintFromPath(exeDir) {
			return RuntimeModeInstalled
		}
		return RuntimeModePortable
	}
	if marker.Mode == string(RuntimeModeInstalled) {
		return RuntimeModeInstalled
	}
	return RuntimeModePortable
}

// installedModeHintFromPath 是无标记时的兜底启发式：只认已发布安装包的落位。
func installedModeHintFromPath(exeDir string) bool {
	switch runtime.GOOS {
	case "linux":
		for _, prefix := range []string{"/usr/bin", "/usr/local/bin", "/opt/"} {
			if strings.HasPrefix(filepath.ToSlash(exeDir), prefix) {
				return true
			}
		}
		return false
	case "darwin":
		// dmg 拖出来的就是安装态：不存在承诺支持的裸二进制便携形态。
		return strings.Contains(filepath.ToSlash(exeDir), ".app/Contents/MacOS")
	default:
		return false
	}
}

func readInstallMarker(exeDir string) (*InstallMarker, error) {
	raw, err := os.ReadFile(filepath.Join(exeDir, InstallMarkerFileName))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		println("runtime layout: 读取安装标记失败:", err.Error())
		return nil, err
	}
	var marker InstallMarker
	if err := json.Unmarshal(raw, &marker); err != nil {
		println("runtime layout: 安装标记损坏，按便携态处理:", err.Error())
		return nil, err
	}
	return &marker, nil
}

// readDataRootPointer 读指针文件；损坏时隔离为 data-root.json.corrupt-<ts>（保留不删）。
// 返回 (内容, 隔离路径)：内容为 nil 表示没有可用指针。
func readDataRootPointer(pointerPath string) (*DataRootPointer, string) {
	if pointerPath == "" {
		return nil, ""
	}
	raw, err := os.ReadFile(pointerPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ""
	}
	if err != nil {
		println("runtime layout: 读取指针文件失败:", err.Error())
		return nil, ""
	}
	var ptr DataRootPointer
	if err := json.Unmarshal(raw, &ptr); err != nil {
		return nil, quarantineFile(pointerPath)
	}
	return &ptr, ""
}

// SaveDataRootPointer 写入指定路径的指针文件。
func SaveDataRootPointer(pointerPath string, pointer DataRootPointer) error {
	if strings.TrimSpace(pointerPath) == "" {
		return errors.New("指针文件路径为空")
	}
	pointer.Version = pointerFileVersion
	pointer.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	payload, err := json.MarshalIndent(pointer, "", "  ")
	if err != nil {
		return fmt.Errorf("编码指针文件失败: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(pointerPath), 0o755); err != nil {
		return fmt.Errorf("创建指针文件目录失败: %w", err)
	}
	tmpPath := fmt.Sprintf("%s.tmp-%d", pointerPath, time.Now().UnixNano())
	if err := os.WriteFile(tmpPath, payload, 0o600); err != nil {
		return fmt.Errorf("写入指针文件失败: %w", err)
	}
	if err := os.Rename(tmpPath, pointerPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("替换指针文件失败: %w", err)
	}
	return nil
}

// PointerPathForLayout 返回当前解析结果对应的指针文件路径（迁移写指针时复用同一路径）。
func PointerPathForLayout(layout RuntimeLayout) string {
	if layout.PointerPath != "" {
		return layout.PointerPath
	}
	dir, err := OsPointerDir()
	if err != nil {
		return ""
	}
	return pointerPathFor(dir)
}

func pointerPathFor(pointerDir string) string {
	if strings.TrimSpace(pointerDir) == "" {
		return ""
	}
	return filepath.Join(pointerDir, PointerFileName)
}

// adoptionCandidates 是第 4 档的候选根顺序：先 exe 同级（老便携），再 OS 用户数据目录。
func adoptionCandidates(exeDir string, osDir string) []string {
	candidates := []string{filepath.Join(exeDir, DataDirName)}
	if osDir != "" && !pathsEqual(osDir, candidates[0]) {
		candidates = append(candidates, osDir)
	}
	return candidates
}

// usableChosenRoot 判用户选的根还能不能用：目录在用；目录不在但其最近存在的祖先可写（新位置首启）。
func usableChosenRoot(chosen string, in layoutInput) bool {
	chosen = absolutize(chosen)
	info, err := os.Stat(chosen)
	if err == nil {
		return info.IsDir()
	}
	if !errors.Is(err, os.ErrNotExist) {
		return false
	}
	probe := in.probeWritable
	if probe == nil {
		probe = probeWritable
	}
	for parent := filepath.Dir(chosen); ; parent = filepath.Dir(parent) {
		if pinfo, perr := os.Stat(parent); perr == nil && pinfo.IsDir() {
			return probe(parent)
		}
		next := filepath.Dir(parent)
		if next == parent {
			return false
		}
	}
}

func directoryMissing(path string) bool {
	_, err := os.Stat(path)
	return errors.Is(err, os.ErrNotExist)
}

func hasMainDataFile(dataRoot string) bool {
	if strings.TrimSpace(dataRoot) == "" {
		return false
	}
	info, err := os.Stat(MainDataDocPath(dataRoot))
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

func envValue(in layoutInput, key string) string {
	if in.lookupEnv == nil {
		return os.Getenv(key)
	}
	value, _ := in.lookupEnv(key)
	return value
}

func absolutize(path string) string {
	abs, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return filepath.Clean(path)
	}
	return abs
}

// quarantineFile 把损坏文件改名保留（沿用主数据文件的隔离策略，绝不直接删）。
func quarantineFile(path string) string {
	quarantine := fmt.Sprintf("%s%s%d", path, corruptFileSuffix, time.Now().UnixNano())
	if err := os.Rename(path, quarantine); err != nil {
		println("runtime layout: 隔离损坏文件失败:", err.Error())
		return ""
	}
	return quarantine
}

// pathsEqual 比较两个路径是否指向同一位置（Windows 路径大小写不敏感）。
func pathsEqual(a string, b string) bool {
	if strings.TrimSpace(a) == "" || strings.TrimSpace(b) == "" {
		return false
	}
	return canonicalPath(a) == canonicalPath(b)
}

// isAncestorDir 判 ancestor 是否为 descendant 的严格祖先目录（不含相等）。
// copyDirectory 只判 samePath 时挡不住「父目录往自己的子目录里拷」的递归自拷。
func isAncestorDir(ancestor string, descendant string) bool {
	if strings.TrimSpace(ancestor) == "" || strings.TrimSpace(descendant) == "" {
		return false
	}
	a := strings.TrimRight(canonicalPath(ancestor), string(filepath.Separator))
	d := canonicalPath(descendant)
	if a == "" || a == d {
		return false
	}
	return strings.HasPrefix(d, a+string(filepath.Separator))
}

func canonicalPath(path string) string {
	cleaned := filepath.Clean(filepath.ToSlash(path))
	if pathsAreCaseInsensitive() {
		return strings.ToLower(cleaned)
	}
	return cleaned
}

func pathsAreCaseInsensitive() bool {
	return runtime.GOOS == "windows"
}

// OsUserDataDir 返回安装态/不可写兜底用的 OS 用户数据目录（标准库取值，不自己拼平台串）。
func OsUserDataDir() (string, error) {
	switch runtime.GOOS {
	case "windows":
		if dir := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); dir != "" {
			return filepath.Join(dir, "ConfScope"), nil
		}
		dir, err := os.UserCacheDir()
		if err != nil {
			return "", fmt.Errorf("获取本地应用数据目录失败: %w", err)
		}
		return filepath.Join(dir, "ConfScope"), nil
	case "linux":
		if dir := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); dir != "" {
			return filepath.Join(dir, "confscope"), nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("获取用户目录失败: %w", err)
		}
		return filepath.Join(home, ".local", "share", "confscope"), nil
	default:
		// darwin 的 UserConfigDir 就是 ~/Library/Application Support；其余平台按同规则收。
		dir, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("获取用户配置目录失败: %w", err)
		}
		return filepath.Join(dir, "ConfScope"), nil
	}
}

// OsPointerDir 返回指针文件所在目录（刻意与 OsUserDataDir 不同，指针不能随数据根一起搬）。
func OsPointerDir() (string, error) {
	switch runtime.GOOS {
	case "windows":
		dir, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("获取用户配置目录失败: %w", err)
		}
		return filepath.Join(dir, "ConfScope"), nil
	case "linux":
		if dir := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); dir != "" {
			return filepath.Join(dir, "confscope"), nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("获取用户目录失败: %w", err)
		}
		return filepath.Join(home, ".config", "confscope"), nil
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("获取用户目录失败: %w", err)
		}
		return filepath.Join(home, "Library", "Preferences", "ConfScope"), nil
	default:
		dir, err := os.UserConfigDir()
		if err != nil {
			return "", fmt.Errorf("获取用户配置目录失败: %w", err)
		}
		return filepath.Join(dir, "ConfScopeRuntime"), nil
	}
}

var (
	writableProbeMu    sync.Mutex
	writableProbeCache = map[string]bool{}
)

// probeWritable 用 O_CREATE|O_EXCL 试写一个探针文件判目录可写，结果按目录缓存
// （解析链会在启动/设置页/迁移校验里被反复调用，不能每次都往用户目录造文件）。
func probeWritable(dir string) bool {
	if strings.TrimSpace(dir) == "" {
		return false
	}
	key := absolutize(dir)
	info, err := os.Stat(key)
	if err != nil || !info.IsDir() {
		// 目录还不存在时不进缓存：启动链路随后会 MkdirAll 把它建出来，
		// 缓存住 false 就等于「显示新根、写入旧根」那一类最难查的 stale-cache bug。
		return false
	}
	writableProbeMu.Lock()
	defer writableProbeMu.Unlock()
	if cached, ok := writableProbeCache[key]; ok {
		return cached
	}
	result := testWritableDir(key)
	writableProbeCache[key] = result
	return result
}

func testWritableDir(dir string) bool {
	probe := filepath.Join(dir, fmt.Sprintf(".confscope-writable-probe-%d", time.Now().UnixNano()))
	file, err := os.OpenFile(probe, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	closeErr := file.Close()
	removeErr := os.Remove(probe)
	if closeErr != nil || removeErr != nil {
		return false
	}
	return true
}

// ResetWritableProbeCacheForTest 清掉可写性缓存（仅测试用：同一进程内 TempDir 路径会复用）。
func ResetWritableProbeCacheForTest() {
	writableProbeMu.Lock()
	defer writableProbeMu.Unlock()
	writableProbeCache = map[string]bool{}
}

// LayoutFor 按真实 OS 环境解析指定 exe 的运行形态与数据根。
//
// 刻意不做跨调用缓存：数据根会被迁移改指针，缓存会立刻变成
// 「界面显示新根、写入仍在旧根」这类最难查的 bug。解析本身很轻。
func LayoutFor(exePath string) (RuntimeLayout, error) {
	return resolveLayout(layoutInput{
		exePath:       exePath,
		lookupEnv:     os.LookupEnv,
		osDataDir:     OsUserDataDir,
		pointerDir:    OsPointerDir,
		probeWritable: probeWritable,
	})
}

// DataRootFor 返回指定 exe 的数据根；解析失败时退回「exe 同级 ConfScopeData」，
// 保持这个函数永不失败的历史语义（调用方遍布启动链路）。
func DataRootFor(exePath string) string {
	layout, err := LayoutFor(exePath)
	if err != nil || strings.TrimSpace(layout.DataRoot) == "" {
		return filepath.Join(filepath.Dir(exePath), DataDirName)
	}
	return layout.DataRoot
}

// LogRuntimeLayout 把解析结果追加到 [数据根]/logs/data-root.log（best-effort）。
// 「数据到底落在哪」必须由程序自己留证据，而不是让用户猜。
func LogRuntimeLayout(layout RuntimeLayout) string {
	if strings.TrimSpace(layout.DataRoot) == "" {
		return ""
	}
	line := fmt.Sprintf("mode=%s\tsource=%s\troot=%s\tpointer=%s\texeWritable=%t%s",
		layout.Mode, layout.Source, layout.DataRoot,
		layout.PointerPath, layout.ExeDirWritable, notesSuffix(layout.Notes))
	return AppendRuntimeLogLine(layout.DataRoot, line)
}

// AppendRuntimeLogLine 往 [数据根]/logs/[RuntimeLogFileName] 追加一行带时间戳的记录，
// 返回日志路径（写不成也返回尽力算出的路径，空数据根才返回空串）。
//
// 单独抽出这一支是因为退出路径也需要自证据：桌面应用没有控制台，
// println 在 Windows 上到不了任何地方，而「哪条隧道拖住了退出」正是用户
// 装不上新版本时唯一能查的东西。best-effort：日志写失败绝不许挡住退出。
func AppendRuntimeLogLine(dataRoot string, line string) string {
	if strings.TrimSpace(dataRoot) == "" || strings.TrimSpace(line) == "" {
		return ""
	}
	logDir := filepath.Join(dataRoot, LogsDirName)
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		println("runtime log: 创建日志目录失败:", err.Error())
		return ""
	}
	path := filepath.Join(logDir, RuntimeLogFileName)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		println("runtime log: 打开启动日志失败:", err.Error())
		return path
	}
	defer file.Close()
	if _, err := file.WriteString(fmt.Sprintf("%s\t%s\n", time.Now().Format(time.RFC3339), line)); err != nil {
		println("runtime log: 写启动日志失败:", err.Error())
	}
	return path
}

func notesSuffix(notes []string) string {
	if len(notes) == 0 {
		return ""
	}
	return "\tnotes=" + strings.Join(notes, " | ")
}

// MigratedMarkerFileName 返回旧根上的迁移标记文件名（只写标记，绝不删数据）。
func MigratedMarkerFileName(timestamp int64) string {
	return fmt.Sprintf("%s%d.marker", MigratedMarkerPrefix, timestamp)
}

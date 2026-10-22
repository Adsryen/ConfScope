package portabledata

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// stubLayout 把真实 OS 目录与可写性探针都换成受控替身，
// 保证单测永远不碰 ~/.local/share 或 ~/.config（AGENTS.md 数据目录纪律）。
type stubLayout struct {
	osDataDir  string
	pointerDir string
	unwritable map[string]bool
	lookupEnv  map[string]string
}

func (s stubLayout) input(exePath string) layoutInput {
	osDir := s.osDataDir
	pointerDir := s.pointerDir
	return layoutInput{
		exePath:   exePath,
		lookupEnv: func(key string) (string, bool) { value, ok := s.lookupEnv[key]; return value, ok },
		osDataDir: func() (string, error) {
			if osDir == "" {
				return "", os.ErrNotExist
			}
			return osDir, nil
		},
		pointerDir: func() (string, error) {
			if pointerDir == "" {
				return "", os.ErrNotExist
			}
			return pointerDir, nil
		},
		probeWritable: func(dir string) bool {
			for blocked := range s.unwritable {
				if strings.HasPrefix(canonicalPath(dir), canonicalPath(blocked)) {
					return false
				}
			}
			return true
		},
	}
}

func (s stubLayout) context(exePath string) runtimeContext {
	input := s.input(exePath)
	return runtimeContext{
		exePath:       exePath,
		lookupEnv:     input.lookupEnv,
		osDataDir:     input.osDataDir,
		pointerDir:    input.pointerDir,
		probeWritable: input.probeWritable,
		now:           func() int64 { return 1730000000000000000 },
	}
}

func writeMainDataDoc(t *testing.T, dataRoot string) string {
	t.Helper()
	path := MainDataDocPath(dataRoot)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll main data doc: %v", err)
	}
	payload, err := json.Marshal(map[string]any{"schemaVersion": 2, "data": map[string]any{"connections": []any{}}})
	if err != nil {
		t.Fatalf("Marshal main data doc: %v", err)
	}
	if err := os.WriteFile(path, payload, 0o644); err != nil {
		t.Fatalf("WriteFile main data doc: %v", err)
	}
	return path
}

func resolve(t *testing.T, in layoutInput) RuntimeLayout {
	t.Helper()
	layout, err := resolveLayout(in)
	if err != nil {
		t.Fatalf("resolveLayout returned error: %v", err)
	}
	return layout
}

func TestResolveLayoutEnvOverrideWinsOverPointerAndMarker(t *testing.T) {
	stub := stubLayout{lookupEnv: map[string]string{DataDirEnvName: filepath.Join(t.TempDir(), "shared")}}
	exeDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(exeDir, InstallMarkerFileName), []byte(`{"mode":"installed"}`), 0o644); err != nil {
		t.Fatalf("WriteFile marker: %v", err)
	}
	layout := resolve(t, stub.input(filepath.Join(exeDir, "ConfScope")))
	if layout.Source != RootSourceEnv {
		t.Fatalf("source = %q, want %q", layout.Source, RootSourceEnv)
	}
	if layout.DataRoot != absolutize(stub.lookupEnv[DataDirEnvName]) {
		t.Fatalf("dataRoot = %q, want env override", layout.DataRoot)
	}
	// 模式与数据根同源解析：显式覆盖数据根不改变「本副本是安装态」的判断。
	if layout.Mode != RuntimeModeInstalled {
		t.Fatalf("mode = %q, want %q", layout.Mode, RuntimeModeInstalled)
	}
}

func TestResolveLayoutUserChoicePointerIsSecondTier(t *testing.T) {
	pointerDir := t.TempDir()
	chosen := filepath.Join(t.TempDir(), "moved-data")
	if err := os.MkdirAll(chosen, 0o755); err != nil {
		t.Fatalf("MkdirAll chosen: %v", err)
	}
	previous := filepath.Join(t.TempDir(), "old-data")
	pointer := DataRootPointer{DataRoot: chosen, PreviousRoot: previous}
	if err := SaveDataRootPointer(filepath.Join(pointerDir, PointerFileName), pointer); err != nil {
		t.Fatalf("SaveDataRootPointer: %v", err)
	}

	exeDir := t.TempDir()
	// exe 同级也有旧数据，指针优先级必须更高（第 2 档在第 4 档之前）。
	writeMainDataDoc(t, filepath.Join(exeDir, DataDirName))
	layout := resolve(t, stubLayout{pointerDir: pointerDir, osDataDir: filepath.Join(t.TempDir(), "os")}.input(filepath.Join(exeDir, "ConfScope")))
	if layout.Source != RootSourceUserChoice {
		t.Fatalf("source = %q, want %q", layout.Source, RootSourceUserChoice)
	}
	if layout.DataRoot != chosen {
		t.Fatalf("dataRoot = %q, want %q", layout.DataRoot, chosen)
	}
	if layout.PreviousRoot != previous {
		t.Fatalf("previousRoot = %q, want %q", layout.PreviousRoot, previous)
	}
	if layout.Mode != RuntimeModePortable {
		t.Fatalf("mode = %q, want %q", layout.Mode, RuntimeModePortable)
	}
}

func TestResolveLayoutInstallMarkerFallsToOsUserDataDir(t *testing.T) {
	exeDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(exeDir, InstallMarkerFileName), []byte(`{"mode":"installed","version":"1.9.4"}`), 0o644); err != nil {
		t.Fatalf("WriteFile marker: %v", err)
	}
	osDir := filepath.Join(t.TempDir(), "os")
	layout := resolve(t, stubLayout{osDataDir: osDir, pointerDir: t.TempDir()}.input(filepath.Join(exeDir, "ConfScope")))
	if layout.Mode != RuntimeModeInstalled {
		t.Fatalf("mode = %q, want %q", layout.Mode, RuntimeModeInstalled)
	}
	if layout.Source != RootSourceInstallMarker {
		t.Fatalf("source = %q, want %q", layout.Source, RootSourceInstallMarker)
	}
	if layout.DataRoot != osDir {
		t.Fatalf("dataRoot = %q, want %q", layout.DataRoot, osDir)
	}
}

func TestResolveLayoutAdoptsExistingExeAdjacentDataWithoutMarker(t *testing.T) {
	// 老便携用户：无指针、无标记、exe 同级已有主数据文件 → 零迁移继续用旧根。
	exeDir := t.TempDir()
	legacyRoot := filepath.Join(exeDir, DataDirName)
	writeMainDataDoc(t, legacyRoot)
	layout := resolve(t, stubLayout{osDataDir: filepath.Join(t.TempDir(), "os"), pointerDir: t.TempDir()}.input(filepath.Join(exeDir, "ConfScope")))
	if layout.Source != RootSourceLegacyAdoption {
		t.Fatalf("source = %q, want %q", layout.Source, RootSourceLegacyAdoption)
	}
	if layout.DataRoot != legacyRoot {
		t.Fatalf("dataRoot = %q, want %q", layout.DataRoot, legacyRoot)
	}
}

func TestResolveLayoutAdoptsOsDataDirWhenItHoldsTheData(t *testing.T) {
	exeDir := t.TempDir()
	osDir := filepath.Join(t.TempDir(), "os")
	writeMainDataDoc(t, osDir)
	layout := resolve(t, stubLayout{osDataDir: osDir, pointerDir: t.TempDir()}.input(filepath.Join(exeDir, "ConfScope")))
	if layout.Source != RootSourceLegacyAdoption {
		t.Fatalf("source = %q, want %q", layout.Source, RootSourceLegacyAdoption)
	}
	if layout.DataRoot != osDir {
		t.Fatalf("dataRoot = %q, want %q", layout.DataRoot, osDir)
	}
}

func TestResolveLayoutEmptyLegacyDataFileIsNotAdopted(t *testing.T) {
	exeDir := t.TempDir()
	path := MainDataDocPath(filepath.Join(exeDir, DataDirName))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(path, []byte(""), 0o644); err != nil {
		t.Fatalf("WriteFile empty: %v", err)
	}
	osDir := filepath.Join(t.TempDir(), "os")
	layout := resolve(t, stubLayout{osDataDir: osDir, pointerDir: t.TempDir()}.input(filepath.Join(exeDir, "ConfScope")))
	if layout.Source != RootSourceExeAdjacent {
		t.Fatalf("source = %q, want %q", layout.Source, RootSourceExeAdjacent)
	}
}

func TestResolveLayoutUnwritableExeDirFallsBackToOsDataDir(t *testing.T) {
	// 已发布 deb/rpm/dmg 的真实形状：exe 同级不可写，也没有安装标记。
	exeDir := t.TempDir()
	osDir := filepath.Join(t.TempDir(), "os")
	in := stubLayout{osDataDir: osDir, pointerDir: t.TempDir(), unwritable: map[string]bool{exeDir: true}}.input(filepath.Join(exeDir, "confscope"))
	layout := resolve(t, in)
	if layout.Source != RootSourceOsUserData {
		t.Fatalf("source = %q, want %q", layout.Source, RootSourceOsUserData)
	}
	if layout.DataRoot != osDir {
		t.Fatalf("dataRoot = %q, want %q", layout.DataRoot, osDir)
	}
	if layout.ExeDirWritable {
		t.Fatalf("exeDirWritable = true, want false")
	}
	if strings.Join(layout.Notes, " ") == "" {
		t.Fatalf("notes 必须记录兜底原因，实际为空")
	}
}

func TestResolveLayoutUnwritableExeDirWithoutOsDirKeepsExeAdjacent(t *testing.T) {
	exeDir := t.TempDir()
	in := stubLayout{unwritable: map[string]bool{exeDir: true}, pointerDir: t.TempDir()}.input(filepath.Join(exeDir, "confscope"))
	layout := resolve(t, in)
	if layout.DataRoot != filepath.Join(exeDir, DataDirName) {
		t.Fatalf("dataRoot = %q, want exe-adjacent fallback", layout.DataRoot)
	}
	if layout.Source != RootSourceExeAdjacent {
		t.Fatalf("source = %q, want %q", layout.Source, RootSourceExeAdjacent)
	}
}

func TestResolveLayoutIgnoresCorruptInstallMarker(t *testing.T) {
	exeDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(exeDir, InstallMarkerFileName), []byte("{not-json"), 0o644); err != nil {
		t.Fatalf("WriteFile corrupt marker: %v", err)
	}
	osDir := filepath.Join(t.TempDir(), "os")
	layout := resolve(t, stubLayout{osDataDir: osDir, pointerDir: t.TempDir()}.input(filepath.Join(exeDir, "ConfScope")))
	if layout.Mode != RuntimeModePortable {
		t.Fatalf("mode = %q, want %q", layout.Mode, RuntimeModePortable)
	}
	if layout.Source == RootSourceInstallMarker {
		t.Fatalf("损坏标记不得决定数据根")
	}
	if layout.DataRoot != filepath.Join(exeDir, DataDirName) {
		t.Fatalf("dataRoot = %q, want exe-adjacent", layout.DataRoot)
	}
}

func TestResolveLayoutIgnoresUnknownMarkerMode(t *testing.T) {
	exeDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(exeDir, InstallMarkerFileName), []byte(`{"mode":"whatever"}`), 0o644); err != nil {
		t.Fatalf("WriteFile marker: %v", err)
	}
	layout := resolve(t, stubLayout{osDataDir: filepath.Join(t.TempDir(), "os"), pointerDir: t.TempDir()}.input(filepath.Join(exeDir, "ConfScope")))
	if layout.Mode != RuntimeModePortable {
		t.Fatalf("mode = %q, want %q", layout.Mode, RuntimeModePortable)
	}
	if layout.Source != RootSourceExeAdjacent {
		t.Fatalf("source = %q, want %q", layout.Source, RootSourceExeAdjacent)
	}
}

func TestResolveLayoutQuarantinesCorruptPointerAndKeepsResolving(t *testing.T) {
	pointerDir := t.TempDir()
	pointerPath := filepath.Join(pointerDir, PointerFileName)
	if err := os.WriteFile(pointerPath, []byte("{oops"), 0o644); err != nil {
		t.Fatalf("WriteFile corrupt pointer: %v", err)
	}
	exeDir := t.TempDir()
	layout := resolve(t, stubLayout{osDataDir: filepath.Join(t.TempDir(), "os"), pointerDir: pointerDir}.input(filepath.Join(exeDir, "ConfScope")))
	if layout.Source != RootSourceExeAdjacent {
		t.Fatalf("source = %q, want %q", layout.Source, RootSourceExeAdjacent)
	}
	if !strings.Contains(strings.Join(layout.Notes, " "), "指针文件损坏") {
		t.Fatalf("notes = %v, want 指针损坏说明", layout.Notes)
	}
	entries, err := os.ReadDir(pointerDir)
	if err != nil {
		t.Fatalf("ReadDir pointerDir: %v", err)
	}
	if len(entries) != 1 || !strings.Contains(entries[0].Name(), corruptFileSuffix) {
		t.Fatalf("损坏指针必须隔离保留，dir entries = %+v", entries)
	}
}

func TestResolveLayoutRejectsPointerToUnreachableRoot(t *testing.T) {
	pointerDir := t.TempDir()
	// 根不存在、最近存在的祖先又不可写（模拟已拔掉的移动盘挂载点）→ 不得把数据写进空气里。
	deadMount := t.TempDir()
	gone := filepath.Join(deadMount, "usb", "data")
	if err := SaveDataRootPointer(filepath.Join(pointerDir, PointerFileName), DataRootPointer{DataRoot: gone}); err != nil {
		t.Fatalf("SaveDataRootPointer: %v", err)
	}
	exeDir := t.TempDir()
	osDir := filepath.Join(t.TempDir(), "os")
	layout := resolve(t, stubLayout{osDataDir: osDir, pointerDir: pointerDir, unwritable: map[string]bool{deadMount: true}}.input(filepath.Join(exeDir, "ConfScope")))
	if layout.DataRoot == gone {
		t.Fatalf("不可达的指针根不得成为数据根")
	}
	if strings.Join(layout.Notes, " ") == "" {
		t.Fatalf("notes 必须记录回退原因")
	}
}

func TestResolveLayoutAcceptsPointerToFreshRootUnderWritableParent(t *testing.T) {
	pointerDir := t.TempDir()
	parent := t.TempDir()
	fresh := filepath.Join(parent, "ConfScopeData-new")
	if err := SaveDataRootPointer(filepath.Join(pointerDir, PointerFileName), DataRootPointer{DataRoot: fresh}); err != nil {
		t.Fatalf("SaveDataRootPointer: %v", err)
	}
	layout := resolve(t, stubLayout{osDataDir: filepath.Join(t.TempDir(), "os"), pointerDir: pointerDir}.input(filepath.Join(t.TempDir(), "ConfScope")))
	if layout.Source != RootSourceUserChoice {
		t.Fatalf("source = %q, want %q", layout.Source, RootSourceUserChoice)
	}
	if layout.DataRoot != fresh {
		t.Fatalf("dataRoot = %q, want %q", layout.DataRoot, fresh)
	}
	if _, err := os.Stat(fresh); !os.IsNotExist(err) {
		t.Fatalf("解析链不得创建目录，stat err = %v", err)
	}
}

func TestResolveLayoutSeparatesPointerDirFromOsDataDirOnCollision(t *testing.T) {
	// 平台差异导致两个默认值撞上时，指针必须换地方，否则迁移会把指针当数据搬走。
	shared := filepath.Join(t.TempDir(), "ConfScope")
	exeDir := t.TempDir()
	in := stubLayout{osDataDir: shared, pointerDir: shared}.input(filepath.Join(exeDir, "ConfScope"))
	pointerPath := resolve(t, in).PointerPath
	if filepath.Dir(pointerPath) == shared {
		t.Fatalf("pointerPath = %q, 仍落在数据根里", pointerPath)
	}
	if filepath.Base(pointerPath) != PointerFileName {
		t.Fatalf("pointerPath = %q, want 文件名 %s", pointerPath, PointerFileName)
	}
}

func TestInstalledModeHintFromPathOnlyMatchesPackageLocations(t *testing.T) {
	cases := map[string]bool{
		"/usr/bin":                           true,
		"/usr/local/bin":                     true,
		"/opt/confscope":                     true,
		"/home/ryen/Git/ConfScope/build/bin": false,
		"/tmp/portable":                      false,
	}
	for exeDir, want := range cases {
		if got := installedModeHintFromPath(exeDir); got != want && runtimeGOOS() == "linux" {
			t.Fatalf("installedModeHintFromPath(%q) = %v, want %v", exeDir, got, want)
		}
	}
	if runtimeGOOS() == "darwin" && !installedModeHintFromPath("/Applications/ConfScope.app/Contents/MacOS") {
		t.Fatalf("macOS .app 落位必须判为安装态")
	}
}

func runtimeGOOS() string {
	return runtime.GOOS
}

func TestProbeWritableDoesNotLeaveProbeFileBehind(t *testing.T) {
	ResetWritableProbeCacheForTest()
	dir := t.TempDir()
	if !probeWritable(dir) {
		t.Fatalf("probeWritable = false, want true")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("探针文件必须自删，剩余 %+v", entries)
	}
	// 目录被创建后不得再命中「不存在」的负缓存。
	os.Remove(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if !probeWritable(dir) {
		t.Fatalf("重建后的目录必须重新判为可写")
	}
}

func TestIsAncestorDirBlocksRecursiveSelfCopy(t *testing.T) {
	if !isAncestorDir("/a/b", "/a/b/c") {
		t.Fatalf("isAncestorDir 必须判出祖先")
	}
	if isAncestorDir("/a/b/c", "/a/b/c") {
		t.Fatalf("相等目录不是严格祖先")
	}
	if isAncestorDir("/a/b/c", "/a/b") {
		t.Fatalf("方向反了")
	}
	if isAncestorDir("/a/b", "/a/bc") {
		t.Fatalf("必须按路径段比较，不能只比字符串前缀")
	}
}

func TestMainDataDocPathIsSingleSource(t *testing.T) {
	if MainDataDocPath("/root") != filepath.Join("/root", AppDataDirName, AppDataDocFileName) {
		t.Fatalf("主数据文件相对路径漂了")
	}
}

func TestLogRuntimeLayoutWritesResolutionEvidence(t *testing.T) {
	root := t.TempDir()
	path := LogRuntimeLayout(RuntimeLayout{
		Mode:     RuntimeModeInstalled,
		Source:   RootSourceInstallMarker,
		DataRoot: root,
		Notes:    []string{"测试说明"},
	})
	if path == "" {
		t.Fatalf("日志路径为空")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile log: %v", err)
	}
	line := string(raw)
	for _, want := range []string{"mode=installed", "source=install-marker", root, "测试说明"} {
		if !strings.Contains(line, want) {
			t.Fatalf("日志缺少 %q，实际：%s", want, line)
		}
	}
	// 二次调用追加而非覆盖：档位变化必须留下时序证据。
	LogRuntimeLayout(RuntimeLayout{Mode: RuntimeModePortable, Source: RootSourceExeAdjacent, DataRoot: root})
	again, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile log again: %v", err)
	}
	if strings.Count(string(again), "\n") != 2 {
		t.Fatalf("日志必须追加两行，实际：\n%s", again)
	}
}

func TestDataRootForStillNeverFails(t *testing.T) {
	// 解析失败（空 exe 路径）时退回 exe 同级，保持历史语义。
	if got := DataRootFor(""); got != filepath.Join(".", DataDirName) {
		t.Fatalf("DataRootFor(\"\") = %q, want exe 同级兜底", got)
	}
	root := t.TempDir()
	configured := filepath.Join(root, "shared", DataDirName)
	t.Setenv(DataDirEnvName, configured)
	if got := DataRootFor(filepath.Join(root, "build", "bin", "ConfScope")); got != configured {
		t.Fatalf("DataRootFor = %q, want %q", got, configured)
	}
}

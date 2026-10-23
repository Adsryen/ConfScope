package app

import (
	"os"
	"path/filepath"
	"testing"

	"confscope/internal/portabledata"
)

func TestGetDataLocationsWithEnvOverride(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	// 主数据文件 + webview 目录已存在，snapshots/恢复点尚未创建
	if err := os.MkdirAll(filepath.Join(root, portabledata.WebviewDirName), 0o755); err != nil {
		t.Fatal(err)
	}
	appDataFile := appDataDocPath(root)
	if err := os.MkdirAll(filepath.Dir(appDataFile), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(appDataFile, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	locs := (&App{}).GetDataLocations()
	if locs.DataRoot != root {
		t.Fatalf("DataRoot = %q, want %q", locs.DataRoot, root)
	}

	byKey := map[string]bool{}
	wantPaths := map[string]string{
		dataLocKeyDataRoot:       root,
		dataLocKeyAppDataFile:    appDataFile,
		dataLocKeyWebview:        filepath.Join(root, portabledata.WebviewDirName),
		dataLocKeySnapshots:      filepath.Join(root, portabledata.SnapshotDirName),
		dataLocKeyRecoveryPoints: filepath.Join(root, portabledata.AppDataRecoveryPointDirName),
		dataLocKeyAudit:          filepath.Join(root, auditTrailFileNameForTest()),
		dataLocKeyLogs:           filepath.Join(root, portabledata.LogsDirName),
		// 轮57 本机版本历史：与主数据文件同住 app-data（字面量与 revisions.TrailFileName 对齐）
		dataLocKeyRevisions: filepath.Join(root, portabledata.AppDataDirName, "config-revisions.jsonl"),
	}
	for _, e := range locs.Entries {
		byKey[e.Key] = true
		if wantPaths[e.Key] != e.Path {
			t.Errorf("entry %s path = %q, want %q", e.Key, e.Path, wantPaths[e.Key])
		}
		if e.IsFile != (e.Key == dataLocKeyAppDataFile || e.Key == dataLocKeyAudit || e.Key == dataLocKeyRevisions) {
			t.Errorf("entry %s IsFile = %v, wrong", e.Key, e.IsFile)
		}
	}
	for key := range wantPaths {
		if !byKey[key] {
			t.Errorf("missing entry %s", key)
		}
	}
	// exists 标志
	exists := map[string]bool{}
	for _, e := range locs.Entries {
		exists[e.Key] = e.Exists
	}
	if !exists[dataLocKeyDataRoot] || !exists[dataLocKeyAppDataFile] || !exists[dataLocKeyWebview] {
		t.Errorf("expected dataRoot/appDataFile/webview to exist: %v", exists)
	}
	if exists[dataLocKeySnapshots] || exists[dataLocKeyRecoveryPoints] || exists[dataLocKeyRevisions] {
		t.Errorf("expected snapshots/recoveryPoints/revisions to be absent: %v", exists)
	}

	// 轮62：只读面板也要能自证运行形态与命中档位。
	if locs.Source != string(portabledata.RootSourceEnv) {
		t.Errorf("source = %q, want %q", locs.Source, portabledata.RootSourceEnv)
	}
	switch locs.Mode {
	case string(portabledata.RuntimeModePortable), string(portabledata.RuntimeModeInstalled):
	default:
		t.Errorf("mode = %q, want portable|installed", locs.Mode)
	}
}

func TestGetDataLocationsExposesRuntimeLayoutNotes(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)
	locs := (&App{}).GetDataLocations()
	if locs.Notes == nil {
		t.Fatal("notes 必须是空切片而不是 nil，前端直接 map 才不炸")
	}
	if locs.DataRoot != root {
		t.Fatalf("dataRoot = %q, want %q", locs.DataRoot, root)
	}
}

func TestOpenDataFolderRejectsUnknownKey(t *testing.T) {
	t.Setenv(portabledata.DataDirEnvName, t.TempDir())
	if err := (&App{}).OpenDataFolder("not-a-key"); err == nil {
		t.Fatal("expected error for unknown key")
	}
}

func TestOpenDataFolderMissingLocation(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)
	// snapshots 目录未创建
	if err := (&App{}).OpenDataFolder(dataLocKeySnapshots); err == nil {
		t.Fatal("expected error for missing location")
	}
}

// auditTrailFileNameForTest 避免测试直接依赖 internal/audit 包名。
func auditTrailFileNameForTest() string {
	return "audit-trail.jsonl"
}

// TestDataLocationsRevisionsTracksTheFileAppendWrites 把两处路径算式钉在一起（轮67 R57-WP14）。
//
// 为什么要钉：设置页那条 revisions 走 GetDataLocations 的 filepath.Join(root, app-data, 文件名)，
// 真正写盘走 revisionsDataDir() + internal/revisions 自己的算式。两条式子各写各的，
// 一旦哪边改了目录，设置页就指着一条不存在的路径让用户「打开」——用户看到的是
// 「我的数据丢了」，而数据其实安安静静躺在别处。
func TestDataLocationsRevisionsTracksTheFileAppendWrites(t *testing.T) {
	root := t.TempDir()
	t.Setenv(portabledata.DataDirEnvName, root)

	a := &App{}
	entry := dataLocationByKey(t, a.GetDataLocations(), dataLocKeyRevisions)
	if entry.Exists {
		t.Fatal("还没记过任何版本，条目必须如实报「不存在」，不能凭空造文件")
	}

	if _, err := a.AppendConfigRevision(revisionsInput("gateway: on\n")); err != nil {
		t.Fatalf("追加失败: %v", err)
	}

	after := dataLocationByKey(t, a.GetDataLocations(), dataLocKeyRevisions)
	if after.Path != entry.Path {
		t.Fatalf("路径两次算出来不一样：%q vs %q", entry.Path, after.Path)
	}
	if !after.Exists {
		t.Fatalf("记过一版之后设置页仍说文件不存在：%q", after.Path)
	}
	if !after.IsFile {
		t.Errorf("版本历史是单个 jsonl 文件，isFile=false 会让「打开」用错方式（应定位到文件而非进目录）")
	}
}

func dataLocationByKey(t *testing.T, locs DataLocations, key string) DataLocationEntry {
	t.Helper()
	for _, e := range locs.Entries {
		if e.Key == key {
			return e
		}
	}
	t.Fatalf("数据位置清单里没有 %s，设置页看不见这份数据", key)
	return DataLocationEntry{}
}

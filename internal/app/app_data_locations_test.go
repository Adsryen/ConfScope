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
	}
	for _, e := range locs.Entries {
		byKey[e.Key] = true
		if wantPaths[e.Key] != e.Path {
			t.Errorf("entry %s path = %q, want %q", e.Key, e.Path, wantPaths[e.Key])
		}
		if e.IsFile != (e.Key == dataLocKeyAppDataFile || e.Key == dataLocKeyAudit) {
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
	if exists[dataLocKeySnapshots] || exists[dataLocKeyRecoveryPoints] {
		t.Errorf("expected snapshots/recoveryPoints to be absent: %v", exists)
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

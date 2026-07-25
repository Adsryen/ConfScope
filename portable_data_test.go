package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPreparePortableWebviewDataCopiesLegacyAppDataWhenTargetIsEmpty(t *testing.T) {
	root := t.TempDir()
	exePath := filepath.Join(root, "Desktop", "ConfScope.exe")
	appData := filepath.Join(root, "AppData", "Roaming")
	legacy := filepath.Join(appData, "ConfScope.exe")
	legacyFile := filepath.Join(legacy, "Default", "Local Storage", "leveldb", "000003.log")
	if err := os.MkdirAll(filepath.Dir(legacyFile), 0o755); err != nil {
		t.Fatalf("MkdirAll legacy: %v", err)
	}
	if err := os.WriteFile(legacyFile, []byte("local-storage-data"), 0o644); err != nil {
		t.Fatalf("WriteFile legacy: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(exePath), 0o755); err != nil {
		t.Fatalf("MkdirAll exe dir: %v", err)
	}
	if err := os.WriteFile(exePath, []byte("exe"), 0o644); err != nil {
		t.Fatalf("WriteFile exe: %v", err)
	}

	target, err := preparePortableWebviewDataFor(exePath, appData)
	if err != nil {
		t.Fatalf("preparePortableWebviewDataFor returned error: %v", err)
	}

	wantTarget := filepath.Join(filepath.Dir(exePath), "ConfScopeData", "webview")
	if target != wantTarget {
		t.Fatalf("target = %q, want %q", target, wantTarget)
	}
	copied, err := os.ReadFile(filepath.Join(target, "Default", "Local Storage", "leveldb", "000003.log"))
	if err != nil {
		t.Fatalf("ReadFile copied localStorage: %v", err)
	}
	if string(copied) != "local-storage-data" {
		t.Fatalf("copied data = %q", string(copied))
	}
	if _, err := os.Stat(legacyFile); err != nil {
		t.Fatalf("legacy file should remain for rollback: %v", err)
	}
}

func TestPreparePortableWebviewDataDoesNotOverwriteExistingPortableData(t *testing.T) {
	root := t.TempDir()
	exePath := filepath.Join(root, "Desktop", "ConfScope.exe")
	appData := filepath.Join(root, "AppData", "Roaming")
	targetFile := filepath.Join(filepath.Dir(exePath), "ConfScopeData", "webview", "Default", "Local Storage", "leveldb", "000003.log")
	legacyFile := filepath.Join(appData, "ConfScope-new.exe", "Default", "Local Storage", "leveldb", "000003.log")
	if err := os.MkdirAll(filepath.Dir(targetFile), 0o755); err != nil {
		t.Fatalf("MkdirAll target: %v", err)
	}
	if err := os.WriteFile(targetFile, []byte("portable-data"), 0o644); err != nil {
		t.Fatalf("WriteFile target: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(legacyFile), 0o755); err != nil {
		t.Fatalf("MkdirAll legacy: %v", err)
	}
	if err := os.WriteFile(legacyFile, []byte("legacy-data"), 0o644); err != nil {
		t.Fatalf("WriteFile legacy: %v", err)
	}

	_, err := preparePortableWebviewDataFor(exePath, appData)
	if err != nil {
		t.Fatalf("preparePortableWebviewDataFor returned error: %v", err)
	}
	kept, err := os.ReadFile(targetFile)
	if err != nil {
		t.Fatalf("ReadFile target: %v", err)
	}
	if string(kept) != "portable-data" {
		t.Fatalf("target data = %q, want existing portable data", string(kept))
	}
}

func TestPreparePortableSnapshotDataCopiesLegacyBackupsWhenTargetIsEmpty(t *testing.T) {
	root := t.TempDir()
	exePath := filepath.Join(root, "portable", "ConfScope.exe")
	homeDir := filepath.Join(root, "Users", "tester")
	legacyFile := filepath.Join(homeDir, ".confscope", "backups", "snap_1", "metadata.json")
	if err := os.MkdirAll(filepath.Dir(legacyFile), 0o755); err != nil {
		t.Fatalf("MkdirAll legacy snapshot: %v", err)
	}
	if err := os.WriteFile(legacyFile, []byte(`{"id":"snap_1"}`), 0o644); err != nil {
		t.Fatalf("WriteFile legacy snapshot: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(exePath), 0o755); err != nil {
		t.Fatalf("MkdirAll exe dir: %v", err)
	}

	target, err := preparePortableSnapshotDataFor(exePath, homeDir)
	if err != nil {
		t.Fatalf("preparePortableSnapshotDataFor returned error: %v", err)
	}

	wantTarget := filepath.Join(filepath.Dir(exePath), "ConfScopeData", "snapshots")
	if target != wantTarget {
		t.Fatalf("target = %q, want %q", target, wantTarget)
	}
	copied, err := os.ReadFile(filepath.Join(target, "snap_1", "metadata.json"))
	if err != nil {
		t.Fatalf("ReadFile migrated snapshot: %v", err)
	}
	if string(copied) != `{"id":"snap_1"}` {
		t.Fatalf("copied snapshot = %q", string(copied))
	}
	if _, err := os.Stat(legacyFile); err != nil {
		t.Fatalf("legacy snapshot should remain for rollback: %v", err)
	}
}

func TestPreparePortableSnapshotDataDoesNotOverwriteExistingPortableSnapshots(t *testing.T) {
	root := t.TempDir()
	exePath := filepath.Join(root, "portable", "ConfScope.exe")
	homeDir := filepath.Join(root, "Users", "tester")
	targetFile := filepath.Join(filepath.Dir(exePath), "ConfScopeData", "snapshots", "snap_existing", "metadata.json")
	legacyFile := filepath.Join(homeDir, ".confscope", "backups", "snap_legacy", "metadata.json")
	if err := os.MkdirAll(filepath.Dir(targetFile), 0o755); err != nil {
		t.Fatalf("MkdirAll target snapshot: %v", err)
	}
	if err := os.WriteFile(targetFile, []byte(`{"id":"snap_existing"}`), 0o644); err != nil {
		t.Fatalf("WriteFile target snapshot: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(legacyFile), 0o755); err != nil {
		t.Fatalf("MkdirAll legacy snapshot: %v", err)
	}
	if err := os.WriteFile(legacyFile, []byte(`{"id":"snap_legacy"}`), 0o644); err != nil {
		t.Fatalf("WriteFile legacy snapshot: %v", err)
	}

	target, err := preparePortableSnapshotDataFor(exePath, homeDir)
	if err != nil {
		t.Fatalf("preparePortableSnapshotDataFor returned error: %v", err)
	}

	kept, err := os.ReadFile(filepath.Join(target, "snap_existing", "metadata.json"))
	if err != nil {
		t.Fatalf("ReadFile target snapshot: %v", err)
	}
	if string(kept) != `{"id":"snap_existing"}` {
		t.Fatalf("target snapshot = %q, want existing portable snapshot", string(kept))
	}
	if _, err := os.Stat(filepath.Join(target, "snap_legacy")); !os.IsNotExist(err) {
		t.Fatalf("legacy snapshot should not be merged into non-empty target, stat err = %v", err)
	}
}

func TestPreparePortableAppDataRecoveryPointDataCopiesLegacyWhenTargetIsEmpty(t *testing.T) {
	root := t.TempDir()
	exePath := filepath.Join(root, "portable", "ConfScope.exe")
	homeDir := filepath.Join(root, "Users", "tester")
	legacyFile := filepath.Join(homeDir, ".confscope", "app-data-recovery-points", "recovery.csbackup")
	if err := os.MkdirAll(filepath.Dir(legacyFile), 0o755); err != nil {
		t.Fatalf("MkdirAll legacy recovery point: %v", err)
	}
	if err := os.WriteFile(legacyFile, []byte("encrypted-backup"), 0o600); err != nil {
		t.Fatalf("WriteFile legacy recovery point: %v", err)
	}

	target, err := preparePortableAppDataRecoveryPointDataFor(exePath, homeDir)
	if err != nil {
		t.Fatalf("preparePortableAppDataRecoveryPointDataFor returned error: %v", err)
	}

	wantTarget := filepath.Join(filepath.Dir(exePath), "ConfScopeData", "app-data-recovery-points")
	if target != wantTarget {
		t.Fatalf("target = %q, want %q", target, wantTarget)
	}
	copied, err := os.ReadFile(filepath.Join(target, "recovery.csbackup"))
	if err != nil {
		t.Fatalf("ReadFile migrated recovery point: %v", err)
	}
	if string(copied) != "encrypted-backup" {
		t.Fatalf("copied recovery point = %q", string(copied))
	}
	if _, err := os.Stat(legacyFile); err != nil {
		t.Fatalf("legacy recovery point should remain for rollback: %v", err)
	}
}

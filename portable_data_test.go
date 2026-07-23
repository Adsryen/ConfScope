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

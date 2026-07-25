package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const portableDataDirName = "ConfScopeData"
const portableWebviewDirName = "webview"
const portableSnapshotDirName = "snapshots"
const portableAppDataRecoveryPointDirName = "app-data-recovery-points"

func preparePortableWebviewData() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("get executable path: %w", err)
	}
	appData := os.Getenv("APPDATA")
	if appData == "" {
		appData, _ = os.UserConfigDir()
	}
	return preparePortableWebviewDataFor(exePath, appData)
}

func preparePortableSnapshotData() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("get executable path: %w", err)
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("get user home directory: %w", err)
	}
	return preparePortableSnapshotDataFor(exePath, homeDir)
}

func preparePortableAppDataRecoveryPointData() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("get executable path: %w", err)
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("get user home directory: %w", err)
	}
	return preparePortableAppDataRecoveryPointDataFor(exePath, homeDir)
}

func preparePortableWebviewDataFor(exePath string, appData string) (string, error) {
	target := filepath.Join(portableDataRootFor(exePath), portableWebviewDirName)
	if hasDirectoryEntries(target) {
		return target, nil
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return target, fmt.Errorf("create portable webview data directory: %w", err)
	}
	for _, source := range legacyWebviewUserDataPaths(appData) {
		if samePath(source, target) || !hasDirectoryEntries(source) {
			continue
		}
		if err := copyDirectory(source, target); err != nil {
			return target, fmt.Errorf("migrate legacy webview data from %s: %w", source, err)
		}
		return target, nil
	}
	return target, nil
}

func preparePortableSnapshotDataFor(exePath string, homeDir string) (string, error) {
	target := filepath.Join(portableDataRootFor(exePath), portableSnapshotDirName)
	return preparePortableDirectoryFromLegacy(target, legacySnapshotUserDataPath(homeDir), "snapshots")
}

func preparePortableAppDataRecoveryPointDataFor(exePath string, homeDir string) (string, error) {
	target := filepath.Join(portableDataRootFor(exePath), portableAppDataRecoveryPointDirName)
	return preparePortableDirectoryFromLegacy(target, legacyAppDataRecoveryPointUserDataPath(homeDir), "app data recovery points")
}

func preparePortableDirectoryFromLegacy(target string, source string, label string) (string, error) {
	if hasDirectoryEntries(target) {
		return target, nil
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return target, fmt.Errorf("create portable %s directory: %w", label, err)
	}
	if samePath(source, target) || !hasDirectoryEntries(source) {
		return target, nil
	}
	if err := copyDirectory(source, target); err != nil {
		return target, fmt.Errorf("migrate legacy %s from %s: %w", label, source, err)
	}
	return target, nil
}

func portableDataRootFor(exePath string) string {
	return filepath.Join(filepath.Dir(exePath), portableDataDirName)
}

func legacyWebviewUserDataPaths(appData string) []string {
	if appData == "" {
		return nil
	}
	return []string{
		filepath.Join(appData, "ConfScope.exe"),
		filepath.Join(appData, "ConfScope-new.exe"),
		filepath.Join(appData, "ConfScope"),
	}
}

func legacySnapshotUserDataPath(homeDir string) string {
	if homeDir == "" {
		return ""
	}
	return filepath.Join(homeDir, ".confscope", "backups")
}

func legacyAppDataRecoveryPointUserDataPath(homeDir string) string {
	if homeDir == "" {
		return ""
	}
	return filepath.Join(homeDir, ".confscope", "app-data-recovery-points")
}

func hasDirectoryEntries(path string) bool {
	entries, err := os.ReadDir(path)
	return err == nil && len(entries) > 0
}

func samePath(a string, b string) bool {
	absA, errA := filepath.Abs(a)
	absB, errB := filepath.Abs(b)
	if errA == nil && errB == nil {
		return absA == absB
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

func copyDirectory(source string, target string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		dest := filepath.Join(target, rel)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.MkdirAll(dest, info.Mode().Perm())
		}
		if info.Mode()&os.ModeSymlink != 0 {
			linkTarget, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(linkTarget, dest)
		}
		return copyFile(path, dest, info.Mode().Perm())
	})
}

func copyFile(source string, target string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
}

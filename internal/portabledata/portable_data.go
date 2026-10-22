package portabledata

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

const DataDirName = "ConfScopeData"
const WebviewDirName = "webview"
const SnapshotDirName = "snapshots"
const AppDataRecoveryPointDirName = "app-data-recovery-points"
const DataDirEnvName = "CONFSCOPE_DATA_DIR"

func PrepareWebviewData() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("get executable path: %w", err)
	}
	appData := os.Getenv("APPDATA")
	if appData == "" {
		appData, _ = os.UserConfigDir()
	}
	return PrepareWebviewDataFor(exePath, appData)
}

func PrepareSnapshotData() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("get executable path: %w", err)
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("get user home directory: %w", err)
	}
	return PrepareSnapshotDataFor(exePath, homeDir)
}

func PrepareAppDataRecoveryPointData() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("get executable path: %w", err)
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("get user home directory: %w", err)
	}
	return PrepareAppDataRecoveryPointDataFor(exePath, homeDir)
}

func PrepareWebviewDataFor(exePath string, appData string) (string, error) {
	target := filepath.Join(DataRootFor(exePath), WebviewDirName)
	if hasDirectoryEntries(target) {
		return target, nil
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return target, fmt.Errorf("create portable webview data directory: %w", err)
	}
	for _, source := range legacyWebviewUserDataPaths(appData) {
		if !migratableSource(source, target) {
			continue
		}
		if err := copyDirectory(source, target); err != nil {
			return target, fmt.Errorf("migrate legacy webview data from %s: %w", source, err)
		}
		return target, nil
	}
	return target, nil
}

func PrepareSnapshotDataFor(exePath string, homeDir string) (string, error) {
	target := filepath.Join(DataRootFor(exePath), SnapshotDirName)
	return preparePortableDirectoryFromLegacy(target, legacySnapshotUserDataPath(homeDir), "snapshots")
}

func PrepareAppDataRecoveryPointDataFor(exePath string, homeDir string) (string, error) {
	target := filepath.Join(DataRootFor(exePath), AppDataRecoveryPointDirName)
	return preparePortableDirectoryFromLegacy(target, legacyAppDataRecoveryPointUserDataPath(homeDir), "app data recovery points")
}

func preparePortableDirectoryFromLegacy(target string, source string, label string) (string, error) {
	if hasDirectoryEntries(target) {
		return target, nil
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return target, fmt.Errorf("create portable %s directory: %w", label, err)
	}
	if !migratableSource(source, target) {
		return target, nil
	}
	if err := copyDirectory(source, target); err != nil {
		return target, fmt.Errorf("migrate legacy %s from %s: %w", label, source, err)
	}
	return target, nil
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

// migratableSource 判候选旧目录能不能作为 target 的迁移源：
// 既不能相同，也不能是 target 的祖先——祖先会被 WalkDir 拷进自己的子目录里，
// 形成递归自拷（legacyWebviewUserDataPaths 的第 3 个候选 %APPDATA%\ConfScope
// 就是这种形状，一旦数据根落在它下面就会引爆）。
func migratableSource(source string, target string) bool {
	if samePath(source, target) || isAncestorDir(source, target) {
		return false
	}
	return hasDirectoryEntries(source)
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
	return copyDirectoryExcluding(source, target, defaultCopyExcludes())
}

// defaultCopyExcludes 是随数据根一起搬时必须跳过的运行时契约文件：
// 指针文件在 OS 配置目录、安装标记在 exe 同级，都不属于用户数据。
func defaultCopyExcludes() map[string]bool {
	return map[string]bool{
		PointerFileName:          true,
		InstallMarkerFileName:    true,
		MigrationJournalFileName: true,
	}
}

func copyDirectoryExcluding(source string, target string, exclude map[string]bool) error {
	if isAncestorDir(source, target) || isAncestorDir(target, source) {
		return fmt.Errorf("拒绝递归复制：源目录 %s 与目标目录 %s 互相包含", source, target)
	}
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry != nil && exclude != nil && !entry.IsDir() && exclude[entry.Name()] {
			return nil
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

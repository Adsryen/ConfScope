package snapshotwebdav

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"confscope/internal/provider"
)

const snapshotTempSuffix = ".tmp"

var fileNameUnsafe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// DefaultPackageFileName 返回配置中心快照包默认文件名。
func DefaultPackageFileName(snapshot provider.Snapshot) string {
	id := strings.TrimSpace(snapshot.ID)
	if id == "" {
		id = fmt.Sprintf("snap_%d", time.Now().UnixMilli())
	}
	id = fileNameUnsafe.ReplaceAllString(id, "-")
	id = strings.Trim(id, ".-_")
	if id == "" {
		id = fmt.Sprintf("snap_%d", time.Now().UnixMilli())
	}
	return "confscope-snapshot-" + id + PackageExtension
}

// ImportPackage 将远端快照包导入为本地快照目录。
func ImportPackage(baseDir string, packageBytes []byte, password string, importedFrom ImportedFrom) (*provider.Snapshot, error) {
	snapshot, _, err := DecryptPackage(packageBytes, password)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(baseDir, 0755); err != nil {
		return nil, fmt.Errorf("创建快照目录失败: %w", err)
	}

	remoteID := snapshot.ID
	localID := remoteID
	if !isSafeLocalSnapshotID(localID) || snapshotExists(baseDir, localID) {
		localID = uniqueImportedSnapshotID(baseDir)
	}
	if strings.TrimSpace(importedFrom.ImportedAt) == "" {
		importedFrom.ImportedAt = time.Now().UTC().Format(time.RFC3339)
	}
	snapshot.ID = localID
	snapshot.Path = filepath.Join(baseDir, localID)
	snapshot.RemoteSnapshotID = remoteID
	snapshot.ImportedFrom = &provider.SnapshotImportedFrom{
		Type:       "webdav",
		RemotePath: importedFrom.RemotePath,
		ImportedAt: importedFrom.ImportedAt,
	}
	if snapshot.UpdatedAt == "" {
		snapshot.UpdatedAt = importedFrom.ImportedAt
	}

	if err := writeLocalSnapshot(snapshot); err != nil {
		return nil, err
	}
	return &snapshot, nil
}

func writeLocalSnapshot(snapshot provider.Snapshot) error {
	tempDir := snapshot.Path + snapshotTempSuffix
	_ = os.RemoveAll(tempDir)
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return fmt.Errorf("创建导入临时目录失败: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(tempDir)
	}()

	metadataBytes, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return fmt.Errorf("编码导入快照元信息失败: %w", err)
	}
	if err := os.WriteFile(filepath.Join(tempDir, "metadata.json"), metadataBytes, 0644); err != nil {
		return fmt.Errorf("写入导入快照元信息失败: %w", err)
	}
	if err := writeSnapshotConfigFiles(tempDir, snapshot); err != nil {
		return err
	}
	if err := os.Rename(tempDir, snapshot.Path); err != nil {
		return fmt.Errorf("完成导入快照写入失败: %w", err)
	}
	return nil
}

func writeSnapshotConfigFiles(root string, snapshot provider.Snapshot) error {
	for _, cfg := range snapshot.Configs {
		namespace := cfg.Namespace
		if namespace == "" {
			namespace = snapshotNamespaceDir(snapshot.Source)
		}
		configPath := filepath.Join(root, "configs", namespaceDirName(namespace), cfg.Group, filepath.FromSlash(cfg.DataID))
		if err := os.MkdirAll(filepath.Dir(configPath), 0755); err != nil {
			return fmt.Errorf("创建导入配置目录失败: %w", err)
		}
		if err := os.WriteFile(configPath, []byte(cfg.Content), 0644); err != nil {
			return fmt.Errorf("写入导入配置内容失败: %w", err)
		}
	}
	return nil
}

func snapshotExists(baseDir string, id string) bool {
	if strings.TrimSpace(id) == "" {
		return true
	}
	_, err := os.Stat(filepath.Join(baseDir, id))
	return err == nil
}

func isSafeLocalSnapshotID(id string) bool {
	trimmed := strings.TrimSpace(id)
	if trimmed == "" || trimmed != id {
		return false
	}
	if filepath.IsAbs(trimmed) || strings.ContainsAny(trimmed, `/\`) {
		return false
	}
	if trimmed == "." || trimmed == ".." || strings.Contains(trimmed, "..") {
		return false
	}
	return !fileNameUnsafe.MatchString(trimmed)
}

func uniqueImportedSnapshotID(baseDir string) string {
	for i := 0; ; i++ {
		id := fmt.Sprintf("snap_%d_import", time.Now().UnixNano())
		if i > 0 {
			id = fmt.Sprintf("%s_%d", id, i)
		}
		if !snapshotExists(baseDir, id) {
			return id
		}
	}
}

func snapshotNamespaceDir(source provider.SnapshotSource) string {
	namespace := source.NamespaceID
	if namespace == "" {
		namespace = source.Namespace
	}
	if namespace == "" {
		return "public"
	}
	return namespace
}

func namespaceDirName(namespace string) string {
	if namespace == "" {
		return "public"
	}
	return namespace
}

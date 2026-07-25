package provider

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type ConfigSourceExportResult struct {
	Path        string `json:"path"`
	ConfigCount int    `json:"configCount"`
	Manifest    string `json:"manifest"`
}

// WriteConfigSourceDirectory 将配置按本地快照布局导出为源文件目录。
func WriteConfigSourceDirectory(targetDir string, source SnapshotSource, configs []ConfigSnapshot) (ConfigSourceExportResult, error) {
	targetDir = strings.TrimSpace(targetDir)
	if targetDir == "" {
		return ConfigSourceExportResult{}, fmt.Errorf("导出目录不能为空")
	}
	if len(configs) == 0 {
		return ConfigSourceExportResult{}, fmt.Errorf("没有可导出的配置")
	}
	configCopies := append([]ConfigSnapshot(nil), configs...)
	normalizeSnapshotInput(&source, configCopies)

	now := time.Now()
	snapshot := &Snapshot{
		SchemaVersion: SnapshotSchemaVersion,
		ToolVersion:   SnapshotToolVersion,
		ID:            fmt.Sprintf("export_%d", now.UnixMilli()),
		Path:          targetDir,
		Name:          fmt.Sprintf("%s_%s_%s", source.ConnectionName, source.Namespace, now.Format("20060102_150405")),
		CreatedAt:     now.Format(time.RFC3339),
		UpdatedAt:     now.Format(time.RFC3339),
		Source:        source,
		Configs:       configCopies,
	}

	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return ConfigSourceExportResult{}, fmt.Errorf("创建导出目录失败: %w", err)
	}
	if err := writeSourceExportMetadata(targetDir, snapshot); err != nil {
		return ConfigSourceExportResult{}, err
	}
	if err := writeSourceExportConfigs(targetDir, snapshot); err != nil {
		return ConfigSourceExportResult{}, err
	}
	return ConfigSourceExportResult{
		Path:        targetDir,
		ConfigCount: len(configCopies),
		Manifest:    filepath.Join(targetDir, "metadata.json"),
	}, nil
}

func writeSourceExportMetadata(targetDir string, snapshot *Snapshot) error {
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return fmt.Errorf("生成导出清单失败: %w", err)
	}
	if err := os.WriteFile(filepath.Join(targetDir, "metadata.json"), data, 0o644); err != nil {
		return fmt.Errorf("写入导出清单失败: %w", err)
	}
	if err := os.WriteFile(filepath.Join(targetDir, "confscope.snapshot.json"), data, 0o644); err != nil {
		return fmt.Errorf("写入快照标记失败: %w", err)
	}
	return nil
}

func writeSourceExportConfigs(targetDir string, snapshot *Snapshot) error {
	for _, cfg := range snapshot.Configs {
		namespace := cfg.Namespace
		if namespace == "" {
			namespace = snapshotNamespaceDir(snapshot.Source)
		}
		contentPath, err := sourceExportConfigPath(targetDir, namespace, cfg.Group, cfg.DataID)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(contentPath), 0o755); err != nil {
			return fmt.Errorf("创建配置目录失败: %w", err)
		}
		if err := os.WriteFile(contentPath, []byte(cfg.Content), 0o644); err != nil {
			return fmt.Errorf("写入配置文件失败: %w", err)
		}
	}
	return nil
}

func sourceExportConfigPath(root string, namespace string, group string, dataID string) (string, error) {
	namespaceDir, err := safeSourceExportSegment(namespaceDirName(namespace), "namespace")
	if err != nil {
		return "", err
	}
	groupDir, err := safeSourceExportSegment(group, "group")
	if err != nil {
		return "", err
	}
	cleanDataID, err := safeSourceExportDataID(dataID)
	if err != nil {
		return "", err
	}
	path := filepath.Join(root, "configs", namespaceDir, groupDir, cleanDataID)
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return "", fmt.Errorf("计算导出路径失败: %w", err)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("配置文件路径不安全: %s", dataID)
	}
	return path, nil
}

func safeSourceExportSegment(value string, field string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("配置 %s 不能为空", field)
	}
	if value == "." || value == ".." || strings.ContainsAny(value, `/\`) {
		return "", fmt.Errorf("配置 %s 路径不安全: %s", field, value)
	}
	return value, nil
}

func safeSourceExportDataID(dataID string) (string, error) {
	dataID = strings.TrimSpace(dataID)
	if dataID == "" {
		return "", fmt.Errorf("配置 dataId 不能为空")
	}
	slashed := filepath.ToSlash(dataID)
	if filepath.IsAbs(dataID) || strings.HasPrefix(slashed, "/") {
		return "", fmt.Errorf("配置文件路径不安全: %s", dataID)
	}
	parts := strings.Split(slashed, "/")
	cleanParts := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			return "", fmt.Errorf("配置文件路径不安全: %s", dataID)
		}
		cleanParts = append(cleanParts, part)
	}
	if len(cleanParts) == 0 {
		return "", fmt.Errorf("配置 dataId 不能为空")
	}
	return filepath.Join(cleanParts...), nil
}

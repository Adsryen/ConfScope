package provider

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const snapshotTempSuffix = ".tmp"

// snapshotManager 实现 SnapshotManager 接口。
type snapshotManager struct {
	baseDir string
}

// NewSnapshotManager 创建快照管理器。
func NewSnapshotManager(baseDir string) SnapshotManager {
	return &snapshotManager{baseDir: baseDir}
}

// CreateSnapshot 创建新快照。
func (m *snapshotManager) CreateSnapshot(source SnapshotSource, configs []ConfigSnapshot) (*Snapshot, error) {
	now := time.Now()
	normalizeSnapshotInput(&source, configs)
	snapshot := &Snapshot{
		SchemaVersion: SnapshotSchemaVersion,
		ToolVersion:   SnapshotToolVersion,
		ID:            fmt.Sprintf("snap_%d", now.UnixMilli()),
		Name:          fmt.Sprintf("%s_%s_%s", source.ConnectionName, source.Namespace, now.Format("20060102_150405")),
		CreatedAt:     now.Format(time.RFC3339),
		UpdatedAt:     now.Format(time.RFC3339),
		Source:        source,
		Configs:       configs,
	}

	// 先写入临时目录，全部成功后再落到最终目录，避免失败时留下可被误读的半成品快照。
	snapshotDir := filepath.Join(m.baseDir, snapshot.ID)
	snapshot.Path = snapshotDir
	tempDir := snapshotDir + snapshotTempSuffix
	_ = os.RemoveAll(tempDir)
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return nil, fmt.Errorf("创建快照目录失败: %w", err)
	}
	defer func() {
		_ = os.RemoveAll(tempDir)
	}()

	// 保存元信息
	if err := saveSnapshotMetadata(tempDir, snapshot); err != nil {
		return nil, fmt.Errorf("保存元信息失败: %w", err)
	}

	// 保存配置内容
	if err := saveSnapshotConfigs(tempDir, snapshot); err != nil {
		return nil, fmt.Errorf("保存配置内容失败: %w", err)
	}
	_ = os.RemoveAll(snapshotDir)
	if err := os.Rename(tempDir, snapshotDir); err != nil {
		return nil, fmt.Errorf("完成快照写入失败: %w", err)
	}

	return snapshot, nil
}

// GetSnapshot 获取快照。
func (m *snapshotManager) GetSnapshot(id string) (*Snapshot, error) {
	snapshotDir := filepath.Join(m.baseDir, id)
	metaPath := filepath.Join(snapshotDir, "metadata.json")

	data, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, fmt.Errorf("读取元信息失败: %w", err)
	}

	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, fmt.Errorf("解析元信息失败: %w", err)
	}
	snapshot.Path = snapshotDir

	// 读取配置内容
	for i, cfg := range snapshot.Configs {
		namespace := cfg.Namespace
		if namespace == "" {
			namespace = snapshotNamespaceDir(snapshot.Source)
		}
		contentPath := filepath.Join(snapshotDir, "configs", namespaceDirName(namespace), cfg.Group, filepath.FromSlash(cfg.DataID))
		content, err := os.ReadFile(contentPath)
		if err != nil {
			continue
		}
		snapshot.Configs[i].Content = string(content)
	}

	return &snapshot, nil
}

// ListSnapshots 列出所有快照。
func (m *snapshotManager) ListSnapshots() ([]Snapshot, error) {
	entries, err := os.ReadDir(m.baseDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("读取快照目录失败: %w", err)
	}

	var snapshots []Snapshot
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if strings.HasSuffix(entry.Name(), snapshotTempSuffix) {
			continue
		}
		snapshot, err := m.GetSnapshot(entry.Name())
		if err != nil {
			continue
		}
		snapshots = append(snapshots, *snapshot)
	}

	return snapshots, nil
}

// DeleteSnapshot 删除快照。
func (m *snapshotManager) DeleteSnapshot(id string) error {
	snapshotDir := filepath.Join(m.baseDir, id)
	return os.RemoveAll(snapshotDir)
}

// saveMetadata 保存元信息。
func (m *snapshotManager) saveMetadata(snapshot *Snapshot) error {
	return saveSnapshotMetadata(filepath.Join(m.baseDir, snapshot.ID), snapshot)
}

func saveSnapshotMetadata(snapshotDir string, snapshot *Snapshot) error {
	metaPath := filepath.Join(snapshotDir, "metadata.json")
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(metaPath, data, 0644)
}

// saveConfigs 保存配置内容。
func (m *snapshotManager) saveConfigs(snapshot *Snapshot) error {
	return saveSnapshotConfigs(filepath.Join(m.baseDir, snapshot.ID), snapshot)
}

func saveSnapshotConfigs(snapshotDir string, snapshot *Snapshot) error {
	configsDir := filepath.Join(snapshotDir, "configs")
	if err := os.MkdirAll(configsDir, 0755); err != nil {
		return err
	}

	for _, cfg := range snapshot.Configs {
		namespace := cfg.Namespace
		if namespace == "" {
			namespace = snapshotNamespaceDir(snapshot.Source)
		}
		groupDir := filepath.Join(configsDir, namespaceDirName(namespace), cfg.Group)
		if err := os.MkdirAll(groupDir, 0755); err != nil {
			return err
		}
		contentPath := filepath.Join(groupDir, filepath.FromSlash(cfg.DataID))
		if err := os.MkdirAll(filepath.Dir(contentPath), 0755); err != nil {
			return err
		}
		if err := os.WriteFile(contentPath, []byte(cfg.Content), 0644); err != nil {
			return err
		}
	}

	return nil
}

func normalizeSnapshotInput(source *SnapshotSource, configs []ConfigSnapshot) {
	if source.Provider == "" {
		source.Provider = ProviderNacos
	}
	for i := range configs {
		if configs[i].Namespace == "" {
			configs[i].Namespace = snapshotNamespaceDir(*source)
		}
		if configs[i].ContentType == "" {
			configs[i].ContentType = configs[i].ConfigType
		}
		if configs[i].ContentType == "" {
			configs[i].ContentType = localFormatFromExt(filepath.Ext(configs[i].DataID))
		}
	}
}

func snapshotNamespaceDir(source SnapshotSource) string {
	namespace := source.NamespaceID
	if namespace == "" {
		namespace = source.Namespace
	}
	if namespace == "" {
		return "public"
	}
	return namespace
}

// ValidateSnapshot 校验快照目录结构。
func (m *snapshotManager) ValidateSnapshot(path string) error {
	result := ValidateLocalSnapshotDirectory(path)
	if !result.Valid {
		return fmt.Errorf("%s", result.Message)
	}
	return nil
}

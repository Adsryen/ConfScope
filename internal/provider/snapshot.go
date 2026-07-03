package provider

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

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
	snapshot := &Snapshot{
		ID:        fmt.Sprintf("snap_%d", now.UnixMilli()),
		Name:      fmt.Sprintf("%s_%s_%s", source.ConnectionName, source.Namespace, now.Format("20060102_150405")),
		CreatedAt: now.Format(time.RFC3339),
		UpdatedAt: now.Format(time.RFC3339),
		Source:    source,
		Configs:   configs,
	}

	// 创建目录
	snapshotDir := filepath.Join(m.baseDir, snapshot.ID)
	snapshot.Path = snapshotDir
	if err := os.MkdirAll(snapshotDir, 0755); err != nil {
		return nil, fmt.Errorf("创建快照目录失败: %w", err)
	}

	// 保存元信息
	if err := m.saveMetadata(snapshot); err != nil {
		return nil, fmt.Errorf("保存元信息失败: %w", err)
	}

	// 保存配置内容
	if err := m.saveConfigs(snapshot); err != nil {
		return nil, fmt.Errorf("保存配置内容失败: %w", err)
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
		contentPath := filepath.Join(snapshotDir, "configs", snapshotNamespaceDir(snapshot.Source), cfg.Group, cfg.DataID)
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
	metaPath := filepath.Join(m.baseDir, snapshot.ID, "metadata.json")
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(metaPath, data, 0644)
}

// saveConfigs 保存配置内容。
func (m *snapshotManager) saveConfigs(snapshot *Snapshot) error {
	configsDir := filepath.Join(m.baseDir, snapshot.ID, "configs")
	if err := os.MkdirAll(configsDir, 0755); err != nil {
		return err
	}

	for _, cfg := range snapshot.Configs {
		groupDir := filepath.Join(configsDir, snapshotNamespaceDir(snapshot.Source), cfg.Group)
		if err := os.MkdirAll(groupDir, 0755); err != nil {
			return err
		}
		contentPath := filepath.Join(groupDir, cfg.DataID)
		if err := os.WriteFile(contentPath, []byte(cfg.Content), 0644); err != nil {
			return err
		}
	}

	return nil
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
	// 检查 metadata.json
	metaPath := filepath.Join(path, "metadata.json")
	if _, err := os.Stat(metaPath); err != nil {
		return fmt.Errorf("缺少 metadata.json")
	}

	// 检查 configs 目录
	configsDir := filepath.Join(path, "configs")
	if _, err := os.Stat(configsDir); err != nil {
		return fmt.Errorf("缺少 configs 目录")
	}

	return nil
}

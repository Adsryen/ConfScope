package snapshot

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSnapshotManager_CreateAndList(t *testing.T) {
	tmpDir := t.TempDir()
	mgr := NewSnapshotManager(tmpDir)

	source := SnapshotSource{
		ConnectionID:   "conn-1",
		ConnectionName: "dev-nacos",
		Namespace:      "public",
		NamespaceID:    "public",
	}

	configs := []ConfigSnapshot{
		{
			DataID:     "app.yaml",
			Group:      "DEFAULT_GROUP",
			Content:    "server:\n  port: 8080",
			ConfigType: "yaml",
			UpdateTime: "2024-01-01 10:00:00",
		},
		{
			DataID:     "db.properties",
			Group:      "DEFAULT_GROUP",
			Content:    "db.url=jdbc:mysql://localhost:3306/test",
			ConfigType: "properties",
			UpdateTime: "2024-01-02 12:00:00",
		},
	}

	// 创建快照
	snapshot, err := mgr.CreateSnapshot(source, configs)
	if err != nil {
		t.Fatalf("创建快照失败: %v", err)
	}

	if snapshot.ID == "" {
		t.Error("快照 ID 不能为空")
	}
	if snapshot.Name == "" {
		t.Error("快照名称不能为空")
	}
	if len(snapshot.Configs) != 2 {
		t.Errorf("期望 2 个配置，实际 %d", len(snapshot.Configs))
	}

	// 列出快照
	snapshots, err := mgr.ListSnapshots()
	if err != nil {
		t.Fatalf("列出快照失败: %v", err)
	}
	if len(snapshots) != 1 {
		t.Errorf("期望 1 个快照，实际 %d", len(snapshots))
	}

	// 获取快照
	got, err := mgr.GetSnapshot(snapshot.ID)
	if err != nil {
		t.Fatalf("获取快照失败: %v", err)
	}
	if got.ID != snapshot.ID {
		t.Errorf("快照 ID 不匹配: %s != %s", got.ID, snapshot.ID)
	}
	if len(got.Configs) != 2 {
		t.Errorf("期望 2 个配置，实际 %d", len(got.Configs))
	}
	if got.Configs[0].Content != configs[0].Content {
		t.Errorf("配置内容不匹配")
	}
}

func TestSnapshotManager_Delete(t *testing.T) {
	tmpDir := t.TempDir()
	mgr := NewSnapshotManager(tmpDir)

	source := SnapshotSource{
		ConnectionID:   "conn-1",
		ConnectionName: "dev-nacos",
		Namespace:      "public",
	}

	snapshot, err := mgr.CreateSnapshot(source, nil)
	if err != nil {
		t.Fatalf("创建快照失败: %v", err)
	}

	// 删除快照
	if err := mgr.DeleteSnapshot(snapshot.ID); err != nil {
		t.Fatalf("删除快照失败: %v", err)
	}

	// 验证已删除
	snapshots, err := mgr.ListSnapshots()
	if err != nil {
		t.Fatalf("列出快照失败: %v", err)
	}
	if len(snapshots) != 0 {
		t.Errorf("期望 0 个快照，实际 %d", len(snapshots))
	}
}

func TestSnapshotManager_Validate(t *testing.T) {
	tmpDir := t.TempDir()
	mgr := NewSnapshotManager(tmpDir)

	// 创建有效快照
	source := SnapshotSource{
		ConnectionID:   "conn-1",
		ConnectionName: "dev-nacos",
		Namespace:      "public",
	}

	snapshot, err := mgr.CreateSnapshot(source, []ConfigSnapshot{
		{DataID: "app.yaml", Group: "DEFAULT_GROUP", Content: "test"},
	})
	if err != nil {
		t.Fatalf("创建快照失败: %v", err)
	}

	// 验证有效快照
	snapshotDir := filepath.Join(tmpDir, snapshot.ID)
	if err := mgr.ValidateSnapshot(snapshotDir); err != nil {
		t.Errorf("验证有效快照失败: %v", err)
	}

	// 验证无效目录
	if err := mgr.ValidateSnapshot(filepath.Join(tmpDir, "nonexistent")); err == nil {
		t.Error("期望验证失败，但成功了")
	}

	// 验证缺少 metadata.json 的目录
	invalidDir := filepath.Join(tmpDir, "invalid")
	os.MkdirAll(invalidDir, 0755)
	if err := mgr.ValidateSnapshot(invalidDir); err == nil {
		t.Error("期望验证失败，但成功了")
	}
}

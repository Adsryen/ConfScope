package provider

import (
	"path/filepath"
	"testing"
)

func TestSnapshotManagerIncludesSnapshotPath(t *testing.T) {
	baseDir := t.TempDir()
	manager := NewSnapshotManager(baseDir)
	source := SnapshotSource{
		ConnectionID:   "conn-1",
		ConnectionName: "dev",
		Namespace:      "public",
		NamespaceID:    "public",
	}

	created, err := manager.CreateSnapshot(source, []ConfigSnapshot{
		{
			DataID:     "app.yaml",
			Group:      "DEFAULT_GROUP",
			Content:    "server:\n  port: 8080",
			ConfigType: "yaml",
		},
	})
	if err != nil {
		t.Fatalf("CreateSnapshot returned error: %v", err)
	}

	wantPath := filepath.Join(baseDir, created.ID)
	if created.Path != wantPath {
		t.Fatalf("created snapshot path = %q, want %q", created.Path, wantPath)
	}

	loaded, err := manager.GetSnapshot(created.ID)
	if err != nil {
		t.Fatalf("GetSnapshot returned error: %v", err)
	}
	if loaded.Path != wantPath {
		t.Fatalf("loaded snapshot path = %q, want %q", loaded.Path, wantPath)
	}

	list, err := manager.ListSnapshots()
	if err != nil {
		t.Fatalf("ListSnapshots returned error: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("ListSnapshots length = %d, want 1", len(list))
	}
	if list[0].Path != wantPath {
		t.Fatalf("listed snapshot path = %q, want %q", list[0].Path, wantPath)
	}

	localProvider := NewLocalProvider()
	page, err := localProvider.ListConfigs(ConnectionProfile{
		ID:       "snapshot-local",
		Provider: ProviderLocal,
		BaseURL:  created.Path,
	}, ListConfigsRequest{
		Namespace: "",
		Group:     "DEFAULT_GROUP",
		DataID:    "app.yaml",
		PageNo:    1,
		PageSize:  10,
	})
	if err != nil {
		t.Fatalf("local provider ListConfigs returned error: %v", err)
	}
	if len(page.PageItems) != 1 {
		t.Fatalf("local provider PageItems length = %d, want 1", len(page.PageItems))
	}
	if page.PageItems[0].Ref.DataID != "app.yaml" {
		t.Fatalf("local provider dataId = %q, want app.yaml", page.PageItems[0].Ref.DataID)
	}

	doc, err := localProvider.GetConfig(ConnectionProfile{
		ID:       "snapshot-local",
		Provider: ProviderLocal,
		BaseURL:  created.Path,
	}, ConfigRef{
		Provider:  ProviderLocal,
		Namespace: "",
		Group:     "DEFAULT_GROUP",
		DataID:    "app.yaml",
	})
	if err != nil {
		t.Fatalf("local provider GetConfig returned error: %v", err)
	}
	if doc.Content != "server:\n  port: 8080" {
		t.Fatalf("local provider content = %q", doc.Content)
	}
}

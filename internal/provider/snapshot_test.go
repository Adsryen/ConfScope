package provider

import (
	"encoding/json"
	"os"
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

func TestSnapshotManagerWritesVersionedMetadataSchema(t *testing.T) {
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
			DataID:     "routes/app.yaml",
			Group:      "DEFAULT_GROUP",
			Content:    "server:\n  port: 8080",
			ConfigType: "yaml",
		},
	})
	if err != nil {
		t.Fatalf("CreateSnapshot returned error: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(created.Path, "metadata.json"))
	if err != nil {
		t.Fatalf("ReadFile metadata returned error: %v", err)
	}
	var metadata Snapshot
	if err := json.Unmarshal(data, &metadata); err != nil {
		t.Fatalf("Unmarshal metadata returned error: %v", err)
	}
	if metadata.SchemaVersion != 1 {
		t.Fatalf("SchemaVersion = %d, want 1", metadata.SchemaVersion)
	}
	if metadata.ToolVersion == "" {
		t.Fatal("ToolVersion is empty")
	}
	if metadata.Path != created.Path {
		t.Fatalf("metadata path = %q, want final path %q", metadata.Path, created.Path)
	}
	if metadata.Source.Provider != ProviderNacos {
		t.Fatalf("Source.Provider = %q, want nacos", metadata.Source.Provider)
	}
	if len(metadata.Configs) != 1 {
		t.Fatalf("Configs length = %d, want 1", len(metadata.Configs))
	}
	if metadata.Configs[0].Namespace != "public" || metadata.Configs[0].ContentType != "yaml" {
		t.Fatalf("config metadata = %+v, want public namespace and yaml contentType", metadata.Configs[0])
	}
	contentPath := filepath.Join(created.Path, "configs", "public", "DEFAULT_GROUP", "routes", "app.yaml")
	if _, err := os.Stat(contentPath); err != nil {
		t.Fatalf("nested dataId content path missing: %v", err)
	}
}

func TestValidateLocalSnapshotDirectoryUsesStrictSchemaAndLegacyFallback(t *testing.T) {
	baseDir := t.TempDir()
	manager := NewSnapshotManager(baseDir)
	created, err := manager.CreateSnapshot(SnapshotSource{
		ConnectionID:   "conn-1",
		ConnectionName: "dev",
		Namespace:      "public",
		NamespaceID:    "public",
	}, []ConfigSnapshot{
		{DataID: "app.yaml", Group: "DEFAULT_GROUP", Content: "a: 1", ConfigType: "yaml"},
	})
	if err != nil {
		t.Fatalf("CreateSnapshot returned error: %v", err)
	}

	result := ValidateLocalSnapshotDirectory(created.Path)
	if !result.Valid || result.Code != "valid" || result.SchemaVersion != 1 || result.Layout != "confscope-v1" || result.Legacy {
		t.Fatalf("strict schema result = %+v, want valid confscope-v1", result)
	}

	invalid := t.TempDir()
	writeLocalConfig(t, invalid, "metadata.json", `{"schemaVersion":1}`)
	writeLocalConfig(t, invalid, "configs/public/DEFAULT_GROUP/app.yaml", "a: 1")
	if result := ValidateLocalSnapshotDirectory(invalid); result.Valid || result.Code != "missing_schema_fields" {
		t.Fatalf("invalid metadata result = %+v, want missing_schema_fields", result)
	}

	legacy := t.TempDir()
	writeLocalConfig(t, legacy, ".metadata.yml", "version: 1")
	writeLocalConfig(t, legacy, "DEFAULT_GROUP/app.yaml", "a: 1")
	if result := ValidateLocalSnapshotDirectory(legacy); !result.Valid || result.Code != "legacy_valid" || !result.Legacy {
		t.Fatalf("legacy result = %+v, want legacy_valid", result)
	}
}

func TestSnapshotManagerCleansPartialDirectoryWhenConfigWriteFails(t *testing.T) {
	baseDir := t.TempDir()
	manager := NewSnapshotManager(baseDir)

	_, err := manager.CreateSnapshot(SnapshotSource{
		ConnectionID:   "conn-1",
		ConnectionName: "dev",
		Namespace:      "public",
		NamespaceID:    "public",
	}, []ConfigSnapshot{
		{
			DataID:     "bad\x00name.yaml",
			Group:      "DEFAULT_GROUP",
			Content:    "a: 1",
			ConfigType: "yaml",
		},
	})
	if err == nil {
		t.Fatal("CreateSnapshot returned nil error")
	}

	entries, readErr := os.ReadDir(baseDir)
	if readErr != nil {
		t.Fatalf("ReadDir returned error: %v", readErr)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("baseDir entries = %v, want no partial snapshot directories", names)
	}

	list, listErr := manager.ListSnapshots()
	if listErr != nil {
		t.Fatalf("ListSnapshots returned error: %v", listErr)
	}
	if len(list) != 0 {
		t.Fatalf("ListSnapshots length = %d, want 0", len(list))
	}
}

func TestSnapshotManagerListSnapshotsSkipsTemporaryDirectories(t *testing.T) {
	baseDir := t.TempDir()
	tempID := "snap_123.tmp"
	tempDir := filepath.Join(baseDir, tempID)
	snapshot := Snapshot{
		SchemaVersion: SnapshotSchemaVersion,
		ToolVersion:   SnapshotToolVersion,
		ID:            "snap_123",
		Path:          filepath.Join(baseDir, "snap_123"),
		Name:          "dev_public_20260706_120000",
		CreatedAt:     "2026-07-06T12:00:00Z",
		UpdatedAt:     "2026-07-06T12:00:00Z",
		Source: SnapshotSource{
			Provider:       ProviderNacos,
			ConnectionID:   "conn-1",
			ConnectionName: "dev",
			Namespace:      "public",
			NamespaceID:    "public",
		},
		Configs: []ConfigSnapshot{
			{
				Namespace:   "public",
				Group:       "DEFAULT_GROUP",
				DataID:      "app.yaml",
				ContentType: "yaml",
			},
		},
	}
	data, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatalf("Marshal snapshot returned error: %v", err)
	}
	writeLocalConfig(t, tempDir, "metadata.json", string(data))
	writeLocalConfig(t, tempDir, "configs/public/DEFAULT_GROUP/app.yaml", "a: 1")

	list, err := NewSnapshotManager(baseDir).ListSnapshots()
	if err != nil {
		t.Fatalf("ListSnapshots returned error: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("ListSnapshots length = %d, want temporary directory skipped", len(list))
	}
}

package provider

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestWriteConfigSourceDirectoryWritesBrowsableSourceFiles(t *testing.T) {
	target := t.TempDir()

	result, err := WriteConfigSourceDirectory(target, SnapshotSource{
		Provider:       ProviderNacos,
		ConnectionID:   "conn-uat",
		ConnectionName: "uat",
		Namespace:      "",
		NamespaceID:    "",
	}, []ConfigSnapshot{
		{
			Namespace:   "",
			Group:       "DEFAULT_GROUP",
			DataID:      "service/app.yaml",
			ContentType: "yaml",
			Content:     "server:\n  port: 8080\n",
			UpdateTime:  "2026-07-24T10:00:00Z",
		},
	})
	if err != nil {
		t.Fatalf("WriteConfigSourceDirectory returned error: %v", err)
	}
	if result.ConfigCount != 1 || result.Path != target {
		t.Fatalf("result = %+v, want one exported file under target", result)
	}

	contentPath := filepath.Join(target, "configs", "public", "DEFAULT_GROUP", "service", "app.yaml")
	content, err := os.ReadFile(contentPath)
	if err != nil {
		t.Fatalf("ReadFile exported source: %v", err)
	}
	if string(content) != "server:\n  port: 8080\n" {
		t.Fatalf("exported content = %q", string(content))
	}
	if validation := ValidateLocalSnapshotDirectory(target); !validation.Valid || validation.ConfigCount != 1 {
		t.Fatalf("validation = %+v, want browsable source directory", validation)
	}

	metadata, err := os.ReadFile(filepath.Join(target, "metadata.json"))
	if err != nil {
		t.Fatalf("ReadFile metadata: %v", err)
	}
	var snapshot Snapshot
	if err := json.Unmarshal(metadata, &snapshot); err != nil {
		t.Fatalf("metadata json: %v", err)
	}
	if snapshot.SchemaVersion != SnapshotSchemaVersion || snapshot.Source.ConnectionID != "conn-uat" || snapshot.Configs[0].DataID != "service/app.yaml" {
		t.Fatalf("snapshot metadata = %+v", snapshot)
	}
	if _, err := os.Stat(filepath.Join(target, "confscope.snapshot.json")); err != nil {
		t.Fatalf("confscope.snapshot.json marker should be written: %v", err)
	}
}

func TestWriteConfigSourceDirectoryRejectsUnsafeDataID(t *testing.T) {
	_, err := WriteConfigSourceDirectory(t.TempDir(), SnapshotSource{ConnectionName: "dev"}, []ConfigSnapshot{
		{Group: "DEFAULT_GROUP", DataID: "../outside.yaml", Content: "bad"},
	})
	if err == nil {
		t.Fatal("WriteConfigSourceDirectory returned nil error for unsafe dataId")
	}
}

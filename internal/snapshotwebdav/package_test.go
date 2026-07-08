package snapshotwebdav

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"confscope/internal/provider"
)

func TestSnapshotPackageEncryptDecryptRoundTrip(t *testing.T) {
	snapshot := sampleSnapshot(t)

	packageBytes, summary, err := EncryptPackage(*snapshot, "snapshot-password")
	if err != nil {
		t.Fatalf("EncryptPackage returned error: %v", err)
	}
	if summary.Format != PackageFormat {
		t.Fatalf("summary format = %q, want %q", summary.Format, PackageFormat)
	}
	if summary.SchemaVersion != PackageSchemaVersion {
		t.Fatalf("summary schema = %d, want %d", summary.SchemaVersion, PackageSchemaVersion)
	}
	if summary.SnapshotID != snapshot.ID || summary.SnapshotName != snapshot.Name || summary.ConfigCount != len(snapshot.Configs) {
		t.Fatalf("summary = %+v, want snapshot metadata", summary)
	}
	if bytes.Contains(packageBytes, []byte("super-secret")) {
		t.Fatal("encrypted .cssnapshot package contains plaintext config content")
	}

	decoded, decodedSummary, err := DecryptPackage(packageBytes, "snapshot-password")
	if err != nil {
		t.Fatalf("DecryptPackage returned error: %v", err)
	}
	if decoded.ID != snapshot.ID || decoded.Source.ConnectionName != "dev-nacos" {
		t.Fatalf("decoded snapshot = %+v, want original identity", decoded)
	}
	if len(decoded.Configs) != 1 || decoded.Configs[0].Content != "password: super-secret\n" {
		t.Fatalf("decoded configs = %+v, want decrypted content", decoded.Configs)
	}
	if decodedSummary.SnapshotID != snapshot.ID {
		t.Fatalf("decoded summary = %+v, want snapshot id %s", decodedSummary, snapshot.ID)
	}
}

func TestSnapshotPackageRejectsInvalidPasswordTamperingAndSchema(t *testing.T) {
	snapshot := sampleSnapshot(t)
	packageBytes, _, err := EncryptPackage(*snapshot, "snapshot-password")
	if err != nil {
		t.Fatalf("EncryptPackage returned error: %v", err)
	}

	if _, _, err := DecryptPackage(packageBytes, "wrong-password"); err == nil || !strings.Contains(err.Error(), "快照包密码错误") {
		t.Fatalf("wrong password error = %v, want snapshot password error", err)
	}

	var envelope map[string]any
	if err := json.Unmarshal(packageBytes, &envelope); err != nil {
		t.Fatalf("unmarshal envelope: %v", err)
	}
	envelope["ciphertext"] = envelope["ciphertext"].(string)[:20] + "AAAA"
	tampered, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal tampered envelope: %v", err)
	}
	if _, _, err := DecryptPackage(tampered, "snapshot-password"); err == nil {
		t.Fatal("DecryptPackage accepted tampered ciphertext")
	}

	envelope["format"] = "confscope.app-data-backup"
	wrongFormat, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal wrong format envelope: %v", err)
	}
	if _, _, err := DecryptPackage(wrongFormat, "snapshot-password"); err == nil || !strings.Contains(err.Error(), "快照包格式无效") {
		t.Fatalf("wrong format error = %v, want format error", err)
	}

	envelope["format"] = PackageFormat
	envelope["schemaVersion"] = float64(999)
	wrongSchema, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal wrong schema envelope: %v", err)
	}
	if _, _, err := DecryptPackage(wrongSchema, "snapshot-password"); err == nil || !strings.Contains(err.Error(), "不支持的快照包版本") {
		t.Fatalf("wrong schema error = %v, want schema error", err)
	}
}

func TestImportPackageCreatesNewSnapshotIDWhenRemoteIDAlreadyExists(t *testing.T) {
	baseDir := t.TempDir()
	manager := provider.NewSnapshotManager(baseDir)
	created, err := manager.CreateSnapshot(sampleSource(), []provider.ConfigSnapshot{
		{DataID: "app.yaml", Group: "DEFAULT_GROUP", Content: "password: super-secret\n", ConfigType: "yaml", ContentType: "yaml"},
	})
	if err != nil {
		t.Fatalf("CreateSnapshot returned error: %v", err)
	}
	loaded, err := manager.GetSnapshot(created.ID)
	if err != nil {
		t.Fatalf("GetSnapshot returned error: %v", err)
	}
	packageBytes, _, err := EncryptPackage(*loaded, "snapshot-password")
	if err != nil {
		t.Fatalf("EncryptPackage returned error: %v", err)
	}

	imported, err := ImportPackage(baseDir, packageBytes, "snapshot-password", ImportedFrom{
		RemotePath: "/confscope/" + DefaultPackageFileName(*loaded),
		ImportedAt: "2026-07-08T12:00:00Z",
	})
	if err != nil {
		t.Fatalf("ImportPackage returned error: %v", err)
	}
	if imported.ID == loaded.ID {
		t.Fatalf("imported ID = %q, want new local ID when remote ID already exists", imported.ID)
	}
	if imported.RemoteSnapshotID != loaded.ID {
		t.Fatalf("remoteSnapshotId = %q, want %q", imported.RemoteSnapshotID, loaded.ID)
	}
	if imported.ImportedFrom == nil || imported.ImportedFrom.RemotePath == "" {
		t.Fatalf("importedFrom = %+v, want remote source metadata", imported.ImportedFrom)
	}
	if result := provider.ValidateLocalSnapshotDirectory(imported.Path); !result.Valid || result.Code != "valid" {
		t.Fatalf("imported validation = %+v, want valid local snapshot", result)
	}

	localProvider := provider.NewLocalProvider()
	doc, err := localProvider.GetConfig(provider.ConnectionProfile{ID: "snapshot-local", Provider: provider.ProviderLocal, BaseURL: imported.Path}, provider.ConfigRef{
		Provider: provider.ProviderLocal,
		Group:    "DEFAULT_GROUP",
		DataID:   "app.yaml",
	})
	if err != nil {
		t.Fatalf("local provider GetConfig returned error: %v", err)
	}
	if doc.Content != "password: super-secret\n" {
		t.Fatalf("imported content = %q, want original config content", doc.Content)
	}

	metadataBytes, err := os.ReadFile(filepath.Join(imported.Path, "metadata.json"))
	if err != nil {
		t.Fatalf("read imported metadata: %v", err)
	}
	if !bytes.Contains(metadataBytes, []byte(`"remoteSnapshotId"`)) || !bytes.Contains(metadataBytes, []byte(`"importedFrom"`)) {
		t.Fatalf("metadata = %s, want remoteSnapshotId and importedFrom", metadataBytes)
	}
}

func TestImportPackageGeneratesSafeLocalIDForUnsafeRemoteSnapshotID(t *testing.T) {
	baseDir := t.TempDir()
	outsideDir := filepath.Join(filepath.Dir(baseDir), "outside")
	defer func() {
		_ = os.RemoveAll(outsideDir)
	}()

	snapshot := sampleSnapshot(t)
	unsafeID := ".." + string(filepath.Separator) + "outside"
	snapshot.ID = unsafeID
	snapshot.Path = outsideDir
	packageBytes, _, err := EncryptPackage(*snapshot, "snapshot-password")
	if err != nil {
		t.Fatalf("EncryptPackage returned error: %v", err)
	}

	imported, err := ImportPackage(baseDir, packageBytes, "snapshot-password", ImportedFrom{
		RemotePath: "/confscope/unsafe.cssnapshot",
		ImportedAt: "2026-07-08T12:00:00Z",
	})
	if err != nil {
		t.Fatalf("ImportPackage returned error: %v", err)
	}
	if imported.ID == unsafeID || strings.Contains(imported.ID, "..") || strings.ContainsAny(imported.ID, `/\`) {
		t.Fatalf("imported ID = %q, want generated safe local ID", imported.ID)
	}
	baseClean := filepath.Clean(baseDir) + string(filepath.Separator)
	importedClean := filepath.Clean(imported.Path) + string(filepath.Separator)
	if !strings.HasPrefix(importedClean, baseClean) {
		t.Fatalf("imported path = %q, want path under %q", imported.Path, baseDir)
	}
	if _, err := os.Stat(outsideDir); !os.IsNotExist(err) {
		t.Fatalf("outside path stat error = %v, want no directory created at %s", err, outsideDir)
	}
	if imported.RemoteSnapshotID != unsafeID {
		t.Fatalf("remoteSnapshotId = %q, want original unsafe remote id %q", imported.RemoteSnapshotID, unsafeID)
	}
}

func TestEncryptPackageRejectsInvalidSnapshotMetadata(t *testing.T) {
	_, _, err := EncryptPackage(provider.Snapshot{ID: "snap_empty", SchemaVersion: provider.SnapshotSchemaVersion}, "snapshot-password")
	if err == nil || !strings.Contains(err.Error(), "快照元信息不完整") {
		t.Fatalf("error = %v, want invalid snapshot metadata error", err)
	}
}

func sampleSnapshot(t *testing.T) *provider.Snapshot {
	t.Helper()
	manager := provider.NewSnapshotManager(t.TempDir())
	created, err := manager.CreateSnapshot(sampleSource(), []provider.ConfigSnapshot{
		{DataID: "app.yaml", Group: "DEFAULT_GROUP", Content: "password: super-secret\n", ConfigType: "yaml", ContentType: "yaml"},
	})
	if err != nil {
		t.Fatalf("CreateSnapshot returned error: %v", err)
	}
	loaded, err := manager.GetSnapshot(created.ID)
	if err != nil {
		t.Fatalf("GetSnapshot returned error: %v", err)
	}
	return loaded
}

func sampleSource() provider.SnapshotSource {
	return provider.SnapshotSource{
		Provider:       provider.ProviderNacos,
		ConnectionID:   "conn-dev",
		ConnectionName: "dev-nacos",
		Namespace:      "public",
		NamespaceID:    "public",
	}
}

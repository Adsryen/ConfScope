package provider

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeLocalConfig(t *testing.T, root string, rel string, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLocalProviderReadsConfigsDirectorySnapshot(t *testing.T) {
	root := t.TempDir()
	writeLocalConfig(t, root, "confscope.snapshot.json", `{"version":1}`)
	writeLocalConfig(t, root, "configs/public/DEFAULT_GROUP/app.yaml", "server:\n  port: 8080")
	writeLocalConfig(t, root, "configs/prod/OPS/feature.properties", "enabled=true")

	provider := NewLocalProvider()
	profile := ConnectionProfile{ID: "local-1", Provider: ProviderLocal, BaseURL: root}

	namespaces, err := provider.ListNamespaces(profile)
	if err != nil {
		t.Fatalf("ListNamespaces returned error: %v", err)
	}
	if len(namespaces) != 2 {
		t.Fatalf("namespaces = %+v, want 2 namespaces", namespaces)
	}
	if namespaces[0].ID != "" || namespaces[0].Name != "public" || namespaces[1].ID != "prod" {
		t.Fatalf("namespaces = %+v, want sorted public/prod", namespaces)
	}

	page, err := provider.ListConfigs(profile, ListConfigsRequest{
		Namespace: "",
		Group:     "DEFAULT_GROUP",
		PageNo:    1,
		PageSize:  20,
	})
	if err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
	if page.TotalCount != 1 || len(page.PageItems) != 1 {
		t.Fatalf("page = %+v, want one item", page)
	}
	item := page.PageItems[0]
	if item.Ref.Provider != ProviderLocal || item.Ref.ConnectionID != "local-1" {
		t.Fatalf("ref = %+v, want local/local-1", item.Ref)
	}
	if item.Ref.Namespace != "" || item.Ref.Group != "DEFAULT_GROUP" || item.Ref.DataID != "app.yaml" {
		t.Fatalf("ref = %+v, want default namespace/DEFAULT_GROUP/app.yaml", item.Ref)
	}
	if item.Format != "yaml" || item.Content == "" {
		t.Fatalf("item = %+v, want yaml content", item)
	}

	doc, err := provider.GetConfig(profile, ConfigRef{
		Namespace: "",
		Group:     "DEFAULT_GROUP",
		DataID:    "app.yaml",
	})
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if doc.Content != "server:\n  port: 8080" || doc.Format != "yaml" {
		t.Fatalf("doc = %+v, want app.yaml content", doc)
	}
	if doc.Source == "" {
		t.Fatal("doc.Source is empty")
	}
}

func TestLocalProviderReadsFallbackLayout(t *testing.T) {
	root := t.TempDir()
	writeLocalConfig(t, root, ".metadata.yml", "version: 1")
	writeLocalConfig(t, root, "public/DEFAULT_GROUP/app.json", `{"enabled":true}`)
	writeLocalConfig(t, root, "root.properties", "a=1")

	provider := NewLocalProvider()
	profile := ConnectionProfile{ID: "local-2", Provider: ProviderLocal, BaseURL: root}

	page, err := provider.ListConfigs(profile, ListConfigsRequest{PageNo: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
	if page.TotalCount != 2 {
		t.Fatalf("TotalCount = %d, want 2", page.TotalCount)
	}

	rootDoc, err := provider.GetConfig(profile, ConfigRef{Namespace: "", Group: "DEFAULT_GROUP", DataID: "root.properties"})
	if err != nil {
		t.Fatalf("GetConfig root returned error: %v", err)
	}
	if rootDoc.Content != "a=1" {
		t.Fatalf("rootDoc.Content = %q, want a=1", rootDoc.Content)
	}
}

func TestLocalProviderTreatsManifestSiblingDirectoriesAsGroups(t *testing.T) {
	root := t.TempDir()
	writeLocalConfig(t, root, ".metadata.yml", "version: 1")
	writeLocalConfig(t, root, "DEFAULT_GROUP/app.yaml", "a: 1")
	writeLocalConfig(t, root, "OPS/routes/gateway.yaml", "route: true")

	provider := NewLocalProvider()
	profile := ConnectionProfile{ID: "local-groups", Provider: ProviderLocal, BaseURL: root}

	page, err := provider.ListConfigs(profile, ListConfigsRequest{Group: "DEFAULT_GROUP", PageNo: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
	if page.TotalCount != 1 || len(page.PageItems) != 1 {
		t.Fatalf("page = %+v, want one DEFAULT_GROUP item", page)
	}
	if got := page.PageItems[0].Ref; got.Namespace != "" || got.Group != "DEFAULT_GROUP" || got.DataID != "app.yaml" {
		t.Fatalf("ref = %+v, want public/DEFAULT_GROUP/app.yaml", got)
	}

	doc, err := provider.GetConfig(profile, ConfigRef{Namespace: "", Group: "OPS", DataID: "routes/gateway.yaml"})
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if doc.Content != "route: true" {
		t.Fatalf("Content = %q, want route: true", doc.Content)
	}
}

func TestLocalProviderRejectsWritesAndMissingConfigs(t *testing.T) {
	root := t.TempDir()
	writeLocalConfig(t, root, "configs/public/DEFAULT_GROUP/app.yaml", "a: 1")

	provider := NewLocalProvider()
	profile := ConnectionProfile{ID: "local-3", Provider: ProviderLocal, BaseURL: root}

	if err := provider.PublishConfig(profile, PublishConfigRequest{}); !errors.Is(err, errLocalReadOnly) {
		t.Fatalf("PublishConfig error = %v, want errLocalReadOnly", err)
	}
	if err := provider.DeleteConfig(profile, ConfigRef{}); !errors.Is(err, errLocalReadOnly) {
		t.Fatalf("DeleteConfig error = %v, want errLocalReadOnly", err)
	}
	if _, err := provider.GetConfig(profile, ConfigRef{Namespace: "", Group: "DEFAULT_GROUP", DataID: "missing.yaml"}); err == nil {
		t.Fatal("GetConfig missing returned nil error")
	}
}

func TestLocalProviderRejectsDirectoryWithoutSnapshotMarker(t *testing.T) {
	root := t.TempDir()
	writeLocalConfig(t, root, "app.yaml", "a: 1")

	provider := NewLocalProvider()
	_, err := provider.ListConfigs(ConnectionProfile{ID: "local-4", Provider: ProviderLocal, BaseURL: root}, ListConfigsRequest{})
	if err == nil || !strings.Contains(err.Error(), "marker") {
		t.Fatalf("ListConfigs error = %v, want marker error", err)
	}
}

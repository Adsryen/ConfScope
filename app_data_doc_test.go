package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testAppDataDocument(t *testing.T) *AppDataDocument {
	t.Helper()
	connections, _ := json.Marshal([]map[string]string{{"id": "c1", "name": "Legacy Nacos"}})
	ui, _ := json.Marshal(map[string]string{"mode": "browse"})
	return &AppDataDocument{
		SchemaVersion: appDataDocSchemaVersion,
		Data: map[string]json.RawMessage{
			"connections": connections,
			"ui":          ui,
		},
	}
}

func TestSaveAndReadAppDataDocumentRoundTrip(t *testing.T) {
	root := t.TempDir()
	doc := testAppDataDocument(t)

	saved := saveAppDataDocument(root, doc, "1.9.0")
	if saved.Error != "" {
		t.Fatalf("saveAppDataDocument returned error: %s", saved.Error)
	}
	if !saved.Exists || !saved.Valid {
		t.Fatalf("saved status = %+v, want exists+valid", saved)
	}
	if saved.SavedAt == "" || saved.AppVersion != "1.9.0" {
		t.Fatalf("saved metadata = savedAt %q version %q, want filled", saved.SavedAt, saved.AppVersion)
	}

	loaded := readAppDataDocument(root)
	if loaded.Error != "" {
		t.Fatalf("readAppDataDocument returned error: %s", loaded.Error)
	}
	if !loaded.Valid || loaded.Document == nil {
		t.Fatalf("loaded status = %+v, want valid document", loaded)
	}
	if loaded.SchemaVersion != appDataDocSchemaVersion {
		t.Fatalf("schemaVersion = %d, want %d", loaded.SchemaVersion, appDataDocSchemaVersion)
	}
	if loaded.SavedAt != saved.SavedAt || loaded.AppVersion != saved.AppVersion {
		t.Fatalf("loaded metadata = %q/%q, want %q/%q", loaded.SavedAt, loaded.AppVersion, saved.SavedAt, saved.AppVersion)
	}
	gotConnections, ok := loaded.Document.Data["connections"]
	if !ok {
		t.Fatalf("loaded document missing connections: %+v", loaded.Document.Data)
	}
	var conns []map[string]string
	if err := json.Unmarshal(gotConnections, &conns); err != nil {
		t.Fatalf("unmarshal connections: %v", err)
	}
	if len(conns) != 1 || conns[0]["id"] != "c1" {
		t.Fatalf("connections = %+v, want c1", conns)
	}
}

func TestReadAppDataDocumentMissing(t *testing.T) {
	root := t.TempDir()
	loaded := readAppDataDocument(root)
	if loaded.Error != "" {
		t.Fatalf("readAppDataDocument returned error: %s", loaded.Error)
	}
	if loaded.Exists || loaded.Valid || loaded.Document != nil {
		t.Fatalf("loaded status = %+v, want missing/invalid/nil", loaded)
	}
}

func TestReadAppDataDocumentCorruptQuarantinesFile(t *testing.T) {
	root := t.TempDir()
	path := appDataDocPath(root)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(path, []byte("{not-json"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	loaded := readAppDataDocument(root)
	if loaded.Error == "" {
		t.Fatalf("loaded status = %+v, want error", loaded)
	}
	if loaded.Valid || loaded.Document != nil {
		t.Fatalf("loaded status = %+v, want invalid", loaded)
	}
	if loaded.CorruptFile == "" || !strings.Contains(loaded.CorruptFile, ".corrupt-") || loaded.CorruptFile == path {
		t.Fatalf("corruptFile = %q, want quarantined path", loaded.CorruptFile)
	}
	if _, err := os.Stat(loaded.CorruptFile); err != nil {
		t.Fatalf("quarantined file missing: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("original corrupt file should be renamed away, stat err=%v", err)
	}

	second := readAppDataDocument(root)
	if second.Exists || second.Valid {
		t.Fatalf("second read = %+v, want missing", second)
	}
}

func TestReadAppDataDocumentRejectsLegacySchemaVersion(t *testing.T) {
	root := t.TempDir()
	path := appDataDocPath(root)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	legacy := `{"schemaVersion":1,"savedAt":"2026-01-01T00:00:00Z","appVersion":"1.0","data":{"connections":[]}}`
	if err := os.WriteFile(path, []byte(legacy), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	loaded := readAppDataDocument(root)
	if loaded.Valid || loaded.Error == "" {
		t.Fatalf("loaded status = %+v, want legacy schema rejected", loaded)
	}
	if loaded.CorruptFile == "" {
		t.Fatalf("legacy schema file should be quarantined, status=%+v", loaded)
	}
}

func TestSaveAppDataDocumentRejectsInvalidDocument(t *testing.T) {
	root := t.TempDir()
	if status := saveAppDataDocument(root, nil, "1.9.0"); status.Error == "" {
		t.Fatalf("nil document should fail, status=%+v", status)
	}
	bad := &AppDataDocument{SchemaVersion: 99, Data: map[string]json.RawMessage{"connections": json.RawMessage(`[]`)}}
	if status := saveAppDataDocument(root, bad, "1.9.0"); status.Error == "" {
		t.Fatalf("unsupported schema should fail, status=%+v", status)
	}
	empty := &AppDataDocument{SchemaVersion: appDataDocSchemaVersion}
	if status := saveAppDataDocument(root, empty, "1.9.0"); status.Error == "" {
		t.Fatalf("empty data section should fail, status=%+v", status)
	}
	if _, err := os.Stat(appDataDocPath(root)); !os.IsNotExist(err) {
		t.Fatalf("invalid document must not create file, stat err=%v", err)
	}
}

func TestSaveAppDataDocumentOverwritesPrevious(t *testing.T) {
	root := t.TempDir()
	first := testAppDataDocument(t)
	first.Data["note"] = json.RawMessage(`"first"`)
	if status := saveAppDataDocument(root, first, "1.9.0"); status.Error != "" {
		t.Fatalf("first save: %s", status.Error)
	}

	second := testAppDataDocument(t)
	second.Data["note"] = json.RawMessage(`"second"`)
	if status := saveAppDataDocument(root, second, "1.9.0"); status.Error != "" {
		t.Fatalf("second save: %s", status.Error)
	}

	loaded := readAppDataDocument(root)
	if !loaded.Valid {
		t.Fatalf("loaded status = %+v, want valid", loaded)
	}
	note, ok := loaded.Document.Data["note"]
	if !ok || string(note) != `"second"` {
		t.Fatalf("note = %s (ok=%v), want \"second\"", note, ok)
	}
	if loaded.SavedAt < first.SavedAt {
		t.Fatalf("savedAt %q not newer than first %q", loaded.SavedAt, first.SavedAt)
	}
}

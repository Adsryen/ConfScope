package export

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"strings"
	"testing"
)

func TestCSVExporter_Export(t *testing.T) {
	exp := &CSVExporter{}
	var buf bytes.Buffer

	items := []ConfigItem{
		{DataID: "app.yaml", Group: "DEFAULT_GROUP", Content: "key: value", Namespace: "dev", UpdateTime: "2024-01-01"},
		{DataID: "config.json", Group: "DEFAULT_GROUP", Content: `{"a": 1}`, Namespace: "dev", UpdateTime: "2024-01-02"},
	}

	err := exp.Export(items, ExportOptions{Format: FormatCSV}, &buf)
	if err != nil {
		t.Fatalf("Export failed: %v", err)
	}

	reader := csv.NewReader(strings.NewReader(buf.String()))
	records, err := reader.ReadAll()
	if err != nil {
		t.Fatalf("CSV parse failed: %v", err)
	}

	if len(records) != 3 { // header + 2 rows
		t.Errorf("expected 3 records, got %d", len(records))
	}

	// 验证表头
	expectedHeader := []string{"namespace", "group", "dataId", "content", "updateTime"}
	for i, h := range expectedHeader {
		if records[0][i] != h {
			t.Errorf("header[%d] = %q, want %q", i, records[0][i], h)
		}
	}

	// 验证数据
	if records[1][0] != "dev" {
		t.Errorf("first row namespace = %q, want %q", records[1][0], "dev")
	}
}

func TestJSONExporter_Export(t *testing.T) {
	exp := &JSONExporter{}
	var buf bytes.Buffer

	items := []ConfigItem{
		{DataID: "app.yaml", Group: "DEFAULT_GROUP", Content: "key: value", Namespace: "dev"},
	}

	err := exp.Export(items, ExportOptions{Format: FormatJSON}, &buf)
	if err != nil {
		t.Fatalf("Export failed: %v", err)
	}

	var result ExportResult
	if err := json.Unmarshal(buf.Bytes(), &result); err != nil {
		t.Fatalf("JSON parse failed: %v", err)
	}

	if result.Total != 1 {
		t.Errorf("total = %d, want 1", result.Total)
	}

	if len(result.Items) != 1 {
		t.Errorf("items count = %d, want 1", len(result.Items))
	}

	if result.Items[0].DataID != "app.yaml" {
		t.Errorf("first item dataId = %q, want %q", result.Items[0].DataID, "app.yaml")
	}
}

func TestDiffExporter_Export(t *testing.T) {
	exp := &DiffExporter{}
	var buf bytes.Buffer

	items := []ConfigItem{
		{DataID: "app.yaml", Group: "DEFAULT_GROUP", Content: "key: value", Namespace: "dev"},
	}

	err := exp.Export(items, ExportOptions{Format: FormatDiff}, &buf)
	if err != nil {
		t.Fatalf("Export failed: %v", err)
	}

	output := buf.String()
	if !strings.Contains(output, "=== dev/DEFAULT_GROUP/app.yaml ===") {
		t.Errorf("output missing header: %q", output)
	}
	if !strings.Contains(output, "key: value") {
		t.Errorf("output missing content: %q", output)
	}
}

func TestYAMLExporter_Export(t *testing.T) {
	exp := &YAMLExporter{}
	var buf bytes.Buffer

	items := []ConfigItem{
		{DataID: "app.yaml", Group: "DEFAULT_GROUP", Content: "key: value", Namespace: "dev"},
	}

	err := exp.Export(items, ExportOptions{Format: FormatYAML, IncludeMeta: true}, &buf)
	if err != nil {
		t.Fatalf("Export failed: %v", err)
	}

	output := buf.String()
	if !strings.Contains(output, "# DataID: app.yaml") {
		t.Errorf("output missing meta: %q", output)
	}
}

func TestPropertiesExporter_Export(t *testing.T) {
	exp := &PropertiesExporter{}
	var buf bytes.Buffer

	items := []ConfigItem{
		{DataID: "app.properties", Group: "DEFAULT_GROUP", Content: "key=value", Namespace: "dev"},
	}

	err := exp.Export(items, ExportOptions{Format: FormatProperties, IncludeMeta: true}, &buf)
	if err != nil {
		t.Fatalf("Export failed: %v", err)
	}

	output := buf.String()
	if !strings.Contains(output, "# DataID: app.properties") {
		t.Errorf("output missing meta: %q", output)
	}
	if !strings.Contains(output, "key=value") {
		t.Errorf("output missing content: %q", output)
	}
}

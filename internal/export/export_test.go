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

func TestCSVExporterMasksSensitiveContentByDefault(t *testing.T) {
	exp := &CSVExporter{}
	var buf bytes.Buffer

	items := []ConfigItem{
		{DataID: "secure.properties", Group: "DEFAULT_GROUP", Content: "db.password=secret123\nserver.port=8080", Namespace: "dev"},
	}

	if err := exp.Export(items, ExportOptions{Format: FormatCSV}, &buf); err != nil {
		t.Fatalf("Export failed: %v", err)
	}

	reader := csv.NewReader(strings.NewReader(buf.String()))
	records, err := reader.ReadAll()
	if err != nil {
		t.Fatalf("CSV parse failed: %v", err)
	}

	if got := records[1][3]; !strings.Contains(got, "db.password=***") {
		t.Fatalf("content = %q, want masked password", got)
	}
	if strings.Contains(records[1][3], "secret123") {
		t.Fatalf("content leaked sensitive value: %q", records[1][3])
	}
}

func TestCSVExporterPreservesSensitiveContentWhenAllowed(t *testing.T) {
	exp := &CSVExporter{}
	var buf bytes.Buffer

	items := []ConfigItem{
		{DataID: "secure.properties", Group: "DEFAULT_GROUP", Content: "db.password=secret123", Namespace: "dev"},
	}

	if err := exp.Export(items, ExportOptions{Format: FormatCSV, Sensitive: true}, &buf); err != nil {
		t.Fatalf("Export failed: %v", err)
	}

	reader := csv.NewReader(strings.NewReader(buf.String()))
	records, err := reader.ReadAll()
	if err != nil {
		t.Fatalf("CSV parse failed: %v", err)
	}

	if got := records[1][3]; got != "db.password=secret123" {
		t.Fatalf("content = %q, want raw password", got)
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

func TestJSONExporterMasksSensitiveContentByDefault(t *testing.T) {
	exp := &JSONExporter{}
	var buf bytes.Buffer

	items := []ConfigItem{
		{DataID: "secure.properties", Group: "DEFAULT_GROUP", Content: "token=tok123\nfeature=true", Namespace: "dev"},
	}

	if err := exp.Export(items, ExportOptions{Format: FormatJSON}, &buf); err != nil {
		t.Fatalf("Export failed: %v", err)
	}

	var result ExportResult
	if err := json.Unmarshal(buf.Bytes(), &result); err != nil {
		t.Fatalf("JSON parse failed: %v", err)
	}

	if got := result.Items[0].Content; !strings.Contains(got, "token=***") {
		t.Fatalf("content = %q, want masked token", got)
	}
	if strings.Contains(result.Items[0].Content, "tok123") {
		t.Fatalf("content leaked sensitive value: %q", result.Items[0].Content)
	}
}

func TestJSONExporterPreservesSensitiveContentWhenAllowed(t *testing.T) {
	exp := &JSONExporter{}
	var buf bytes.Buffer

	items := []ConfigItem{
		{DataID: "secure.properties", Group: "DEFAULT_GROUP", Content: "token=tok123", Namespace: "dev"},
	}

	if err := exp.Export(items, ExportOptions{Format: FormatJSON, Sensitive: true}, &buf); err != nil {
		t.Fatalf("Export failed: %v", err)
	}

	var result ExportResult
	if err := json.Unmarshal(buf.Bytes(), &result); err != nil {
		t.Fatalf("JSON parse failed: %v", err)
	}

	if got := result.Items[0].Content; got != "token=tok123" {
		t.Fatalf("content = %q, want raw token", got)
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

func TestDiffExporterMasksSensitiveContentByDefault(t *testing.T) {
	exp := &DiffExporter{}
	var buf bytes.Buffer

	items := []ConfigItem{
		{DataID: "secure.properties", Group: "DEFAULT_GROUP", Content: "accessKey=ak123", Namespace: "dev"},
	}

	if err := exp.Export(items, ExportOptions{Format: FormatDiff}, &buf); err != nil {
		t.Fatalf("Export failed: %v", err)
	}

	output := buf.String()
	if !strings.Contains(output, "accessKey=***") {
		t.Fatalf("output = %q, want masked accessKey", output)
	}
	if strings.Contains(output, "ak123") {
		t.Fatalf("output leaked sensitive value: %q", output)
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

func TestYAMLExporterMasksSensitiveContentByDefault(t *testing.T) {
	exp := &YAMLExporter{}
	var buf bytes.Buffer

	items := []ConfigItem{
		{DataID: "secure.yaml", Group: "DEFAULT_GROUP", Content: "password: secret123", Namespace: "dev"},
	}

	if err := exp.Export(items, ExportOptions{Format: FormatYAML}, &buf); err != nil {
		t.Fatalf("Export failed: %v", err)
	}

	output := buf.String()
	if !strings.Contains(output, "password: ***") {
		t.Fatalf("output = %q, want masked password", output)
	}
	if strings.Contains(output, "secret123") {
		t.Fatalf("output leaked sensitive value: %q", output)
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

func TestPropertiesExporterMasksSensitiveContentByDefault(t *testing.T) {
	exp := &PropertiesExporter{}
	var buf bytes.Buffer

	items := []ConfigItem{
		{DataID: "secure.properties", Group: "DEFAULT_GROUP", Content: "secretKey=sk123", Namespace: "dev"},
	}

	if err := exp.Export(items, ExportOptions{Format: FormatProperties}, &buf); err != nil {
		t.Fatalf("Export failed: %v", err)
	}

	output := buf.String()
	if !strings.Contains(output, "secretKey=***") {
		t.Fatalf("output = %q, want masked secretKey", output)
	}
	if strings.Contains(output, "sk123") {
		t.Fatalf("output leaked sensitive value: %q", output)
	}
}

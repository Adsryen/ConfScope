package export

import (
	"encoding/json"
	"fmt"
	"io"
)

// DiffItem 表示差异项。
type DiffItem struct {
	DataID     string `json:"dataId"`
	Group      string `json:"group"`
	Namespace  string `json:"namespace"`
	LeftValue  string `json:"leftValue"`
	RightValue string `json:"rightValue"`
	DiffType   string `json:"diffType"` // added, deleted, modified
}

// DiffExportResult 差异导出结果。
type DiffExportResult struct {
	Items      []DiffItem `json:"items"`
	Format     Format     `json:"format"`
	Total      int        `json:"total"`
	ExportTime string     `json:"exportTime"`
}

// DiffExporter 差异文本导出器。
type DiffExporter struct{}

func (e *DiffExporter) Export(items []ConfigItem, opts ExportOptions, w io.Writer) error {
	// 将 ConfigItem 转换为差异文本
	for _, item := range exportItems(items, opts) {
		_, _ = fmt.Fprintf(w, "=== %s/%s/%s ===\n", item.Namespace, item.Group, item.DataID)
		_, _ = fmt.Fprintln(w, item.Content)
		_, _ = fmt.Fprintln(w)
	}
	return nil
}

// DiffJSONExporter 差异 JSON 导出器。
type DiffJSONExporter struct{}

func (e *DiffJSONExporter) Export(items []ConfigItem, opts ExportOptions, w io.Writer) error {
	result := DiffExportResult{
		Format: FormatJSON,
		Total:  len(items),
	}

	for _, item := range exportItems(items, opts) {
		result.Items = append(result.Items, DiffItem{
			DataID:    item.DataID,
			Group:     item.Group,
			Namespace: item.Namespace,
			LeftValue: item.Content,
			DiffType:  "modified",
		})
	}

	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(result); err != nil {
		return fmt.Errorf("JSON 编码失败: %w", err)
	}

	return nil
}

func init() {
	Register(FormatDiff, &DiffExporter{})
}

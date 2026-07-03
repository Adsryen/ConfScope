package export

import (
	"encoding/json"
	"fmt"
	"io"
)

// ExportResult 导出结果。
type ExportResult struct {
	Items     []ConfigItem `json:"items"`
	Format    Format       `json:"format"`
	Total     int          `json:"total"`
	ExportTime string      `json:"exportTime"`
}

// JSONExporter JSON 格式导出器。
type JSONExporter struct{}

func (e *JSONExporter) Export(items []ConfigItem, opts ExportOptions, w io.Writer) error {
	result := ExportResult{
		Items:  items,
		Format: FormatJSON,
		Total:  len(items),
	}

	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(result); err != nil {
		return fmt.Errorf("JSON 编码失败: %w", err)
	}

	return nil
}

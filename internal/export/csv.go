package export

import (
	"encoding/csv"
	"fmt"
	"io"
)

// CSVExporter CSV 格式导出器。
type CSVExporter struct{}

func (e *CSVExporter) Export(items []ConfigItem, opts ExportOptions, w io.Writer) error {
	writer := csv.NewWriter(w)
	defer writer.Flush()

	// 写入表头
	header := []string{"namespace", "group", "dataId", "content", "updateTime"}
	if err := writer.Write(header); err != nil {
		return fmt.Errorf("写入 CSV 表头失败: %w", err)
	}

	// 写入数据
	for _, item := range items {
		record := []string{
			item.Namespace,
			item.Group,
			item.DataID,
			item.Content,
			item.UpdateTime,
		}
		if err := writer.Write(record); err != nil {
			return fmt.Errorf("写入 CSV 记录失败: %w", err)
		}
	}

	return nil
}

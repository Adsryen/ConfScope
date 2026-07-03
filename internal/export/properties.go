package export

import (
	"fmt"
	"io"
	"strings"
)

// PropertiesExporter Properties 格式导出器。
type PropertiesExporter struct{}

func (e *PropertiesExporter) Export(items []ConfigItem, opts ExportOptions, w io.Writer) error {
	for i, item := range items {
		if i > 0 {
			_, _ = fmt.Fprintln(w, "")
		}

		// 写入元信息注释
		if opts.IncludeMeta {
			_, _ = fmt.Fprintf(w, "# DataID: %s\n", item.DataID)
			_, _ = fmt.Fprintf(w, "# Group: %s\n", item.Group)
			_, _ = fmt.Fprintf(w, "# Namespace: %s\n", item.Namespace)
			_, _ = fmt.Fprintf(w, "# Update Time: %s\n", item.UpdateTime)
		}

		// 写入配置内容
		content := strings.TrimSpace(item.Content)
		if content != "" {
			_, _ = fmt.Fprintln(w, content)
		}
	}

	return nil
}

func init() {
	Register(FormatProperties, &PropertiesExporter{})
}

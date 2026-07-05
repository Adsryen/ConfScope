package export

import (
	"fmt"
	"io"
	"strings"
)

// YAMLExporter YAML 格式导出器。
type YAMLExporter struct{}

func (e *YAMLExporter) Export(items []ConfigItem, opts ExportOptions, w io.Writer) error {
	for i, item := range exportItems(items, opts) {
		if i > 0 {
			_, _ = fmt.Fprintln(w, "---")
		}

		// 写入元信息（如果需要）
		if opts.IncludeMeta {
			_, _ = fmt.Fprintf(w, "# DataID: %s\n", item.DataID)
			_, _ = fmt.Fprintf(w, "# Group: %s\n", item.Group)
			_, _ = fmt.Fprintf(w, "# Namespace: %s\n", item.Namespace)
			_, _ = fmt.Fprintf(w, "# Update Time: %s\n", item.UpdateTime)
			_, _ = fmt.Fprintln(w)
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
	Register(FormatYAML, &YAMLExporter{})
}

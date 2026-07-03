// Package export 提供配置导出功能。
package export

import (
	"fmt"
	"io"
)

// Format 定义导出格式类型。
type Format string

const (
	FormatCSV        Format = "csv"
	FormatJSON       Format = "json"
	FormatYAML       Format = "yaml"
	FormatProperties Format = "properties"
	FormatDiff       Format = "diff"
)

// ConfigItem 表示单个配置项。
type ConfigItem struct {
	DataID      string `json:"dataId"`
	Group       string `json:"group"`
	Content     string `json:"content"`
	ConfigType  string `json:"configType"`
	Namespace   string `json:"namespace"`
	NamespaceID string `json:"namespaceId"`
	UpdateTime  string `json:"updateTime"`
}

// ExportOptions 定义导出选项。
type ExportOptions struct {
	Format      Format `json:"format"`
	Sensitive   bool   `json:"sensitive"`    // 是否导出敏感字段
	IncludeMeta bool   `json:"includeMeta"` // 是否包含元信息
}

// Exporter 定义导出接口。
type Exporter interface {
	Export(items []ConfigItem, opts ExportOptions, w io.Writer) error
}

// Registry 导出器注册表。
var registry = map[Format]Exporter{}

// Register 注册导出器。
func Register(format Format, exp Exporter) {
	registry[format] = exp
}

// Get 获取指定格式的导出器。
func Get(format Format) (Exporter, error) {
	exp, ok := registry[format]
	if !ok {
		return nil, fmt.Errorf("不支持的导出格式: %s", format)
	}
	return exp, nil
}

// Export 执行导出。
func Export(items []ConfigItem, opts ExportOptions, w io.Writer) error {
	exp, err := Get(opts.Format)
	if err != nil {
		return err
	}
	return exp.Export(items, opts, w)
}

func init() {
	Register(FormatCSV, &CSVExporter{})
	Register(FormatJSON, &JSONExporter{})
}

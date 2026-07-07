package appbackup

import "strings"

// DefaultBackupFileName 根据元信息生成应用数据备份文件名。
func DefaultBackupFileName(meta PackageMeta) string {
	stamp := strings.TrimSpace(meta.CreatedAt)
	replacer := strings.NewReplacer("-", "", ":", "", "T", "-", ".", "", "Z", "")
	stamp = replacer.Replace(stamp)
	if stamp == "" {
		stamp = "manual"
	}
	return "confscope-app-data-" + stamp + ".csbackup"
}

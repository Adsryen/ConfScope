package appbackup

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// WriteLocalBackup 将加密后的应用数据备份包写入本地文件。
func WriteLocalBackup(path string, packageBytes []byte) error {
	cleanPath := strings.TrimSpace(path)
	if cleanPath == "" {
		return fmt.Errorf("备份文件路径不能为空")
	}
	if err := os.MkdirAll(filepath.Dir(cleanPath), 0o755); err != nil {
		return fmt.Errorf("创建备份目录失败: %w", err)
	}
	if err := os.WriteFile(cleanPath, packageBytes, 0o600); err != nil {
		return fmt.Errorf("写入备份文件失败: %w", err)
	}
	return nil
}

// ReadLocalBackup 读取本地应用数据备份包。
func ReadLocalBackup(path string) ([]byte, error) {
	cleanPath := strings.TrimSpace(path)
	if cleanPath == "" {
		return nil, fmt.Errorf("备份文件路径不能为空")
	}
	out, err := os.ReadFile(cleanPath)
	if err != nil {
		return nil, fmt.Errorf("读取备份文件失败: %w", err)
	}
	return out, nil
}

// Package audit 提供会话审计日志（audit-trail.jsonl）持久化。
//
// 设计原则（对齐 .trellis/spec/backend/logging-guidelines.md）：
//   - 用标准库，无外部依赖；JSONL 只追加，不修改历史
//   - 文件放在 portable 数据根目录（ConfScopeData/audit-trail.jsonl），
//     可用 CONFSCOPE_DATA_DIR 重定向（测试/便携模式）
//   - 绝不记录凭据（access token/密码/密钥）；配置内容允许记录但截断
package audit

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const TrailFileName = "audit-trail.jsonl"

// Append 把一条事件追加到审计文件。content 是前端序列化好的单行 JSON。
// 写入失败不向上抛错（审计失败不能影响主流程），只返回 error 供调用方记录。
func Append(dataDir, content string) error {
	content = strings.TrimSpace(content)
	if content == "" {
		return nil
	}
	// 防御：JSONL 每行必须只含一个 JSON 值；前端保证，这里二次校验。
	var probe json.RawMessage
	if err := json.Unmarshal([]byte(content), &probe); err != nil {
		return fmt.Errorf("审计事件不是合法 JSON: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(dataDir), 0o755); err != nil {
		return err
	}
	path := filepath.Join(dataDir, TrailFileName)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	writer := bufio.NewWriter(f)
	if _, err := writer.WriteString(content + "\n"); err != nil {
		return err
	}
	return writer.Flush()
}

// Clear 清空审计文件（truncate 为 0 字节）。
// 只截断不删除：保持文件句柄/权限/路径不变，避免“文件不存在”分支；
// 文件不存在时直接成功（幂等）。仅由开发者“清理缓存”入口调用。
func Clear(dataDir string) error {
	if dataDir == "" {
		return nil
	}
	path := filepath.Join(dataDir, TrailFileName)
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return nil
	}
	return os.Truncate(path, 0)
}

// ReadLines 读取最近 limit 行事件（从文件尾部取；limit<=0 时取全部上限 5000）。
func ReadLines(dataDir string, limit int) []string {
	if dataDir == "" {
		return nil
	}
	if limit <= 0 {
		limit = 5000
	}
	path := filepath.Join(dataDir, TrailFileName)
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var lines []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) > limit {
		lines = lines[len(lines)-limit:]
	}
	return lines
}

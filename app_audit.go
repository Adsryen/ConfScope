package main

import (
	"errors"
	"os"
	"path/filepath"

	"confscope/internal/audit"
)

// auditDataDir 返回审计 JSONL 所在目录：portable 数据根目录（CONFSCOPE_DATA_DIR
// 可重定向；默认 exe 同级 ConfScopeData/）。与 webview/snapshots 同级，
// 便携分发时随目录一起迁移。
func auditDataDir() string {
	if override := os.Getenv(portableDataDirEnvName); override != "" {
		return filepath.Clean(override)
	}
	exePath, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(exePath), portableDataDirName)
}

// AppendAuditEvent 持久化一条前端审计事件（单行 JSON）。
// 审计失败不阻断主流程：错误只打印，不向上抛。
func (a *App) AppendAuditEvent(raw string) error {
	dir := auditDataDir()
	if dir == "" {
		return errors.New("audit data dir unavailable")
	}
	if err := audit.Append(dir, raw); err != nil {
		println("audit append failed:", err.Error())
	}
	return nil
}

// ReadAuditLogLines 读取最近 limit 行审计事件（limit<=0 时默认上限 5000）。
func (a *App) ReadAuditLogLines(limit int) []string {
	dir := auditDataDir()
	if dir == "" {
		return nil
	}
	return audit.ReadLines(dir, limit)
}


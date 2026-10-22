package app

import (
	"errors"
	"os"

	"confscope/internal/audit"
	"confscope/internal/portabledata"
)

// auditDataDir 返回审计 JSONL 所在目录 = 当前数据根。
//
// 这里过去自己抄了一遍解析规则（env + exe 同级），轮62 起改为调用唯一事实源
// portabledata：解析档位与安装态判断只有一处，审计不会漂到别的目录去。
func auditDataDir() string {
	exePath, err := os.Executable()
	if err != nil {
		println("audit data dir: 获取程序路径失败:", err.Error())
		return ""
	}
	return portabledata.DataRootFor(exePath)
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

// ClearAuditTrail 清空审计文件（开发者“清理缓存”入口）。
// 失败只打印不抛错：清理是辅助动作，不能阻断设置页。
func (a *App) ClearAuditTrail() error {
	dir := auditDataDir()
	if dir == "" {
		return errors.New("audit data dir unavailable")
	}
	if err := audit.Clear(dir); err != nil {
		println("audit clear failed:", err.Error())
		return err
	}
	return nil
}

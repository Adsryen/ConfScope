// 会话审计事件（JSONL）合同：
// 对比、审计、应用等关键操作在前后端都会以事件形式追加进
// <portable root>/audit-trail.jsonl（由 Go 侧持久化），
// 前端通过 window.__auditBridge 把 Web 侧事件转发到 Go 的
// AppendAuditEvent 绑定，从而在原生应用里同样落盘。
//
// 事件均为"只追加"，不修改历史；内容字段可能包含配置文本，
// 但绝不包含凭据（access token / 密码），由构造方保证。
//
// 变更会话（apply-*）约定：
//   - apply_session_start：进入计划的完整现场（源/目标端点 + 全部 items 完整内容）
//   - apply_selection：用户每次勾选变化（选中项 + 每项 before/after 完整内容）
//   - apply_dryrun / apply_execute：第 4/5 步请求（dryRun 标记 + 选中集）
//   - apply_item_result：逐项执行结果（before/after 完整内容 + 错误）
//   - apply_verify：终态（成功/失败/沙箱验证）
//   大 JSON（items 列表等）放在 payload 字段（字符串化），避免嵌套类型膨胀，
//   也方便 jsonl 逐行 grep。

export const AUDIT_EVENT_SCHEMA_VERSION = 1;
export const AUDIT_SESSION_MAX_EVENTS = 2000;

export type AuditEventType =
  | "session_start"
  | "session_end"
  | "compare_start"
  | "compare_result"
  | "compare_error"
  | "audit_run_start"
  | "audit_run_result"
  | "apply_plan_start"
  | "apply_item"
  | "apply_result"
  | "apply_error"
  | "apply_session_start"
  | "apply_selection"
  | "apply_dryrun"
  | "apply_execute"
  | "apply_item_result"
  | "apply_verify";

export interface AuditEventPayload {
  schema: number;
  ts: string; // ISO 8601
  kind: string;
  sessionId?: string;
  appVersion?: string;
  platform?: string;
  planId?: string;
  taskId?: string;
  historyId?: string;
  scope?: string;
  sourceType?: string;
  direction?: string; // 如 "left->right"
  left?: string;
  right?: string;
  mode?: string;
  dataId?: string;
  group?: string;
  source?: { connId: string; name: string; namespace: string; dataId: string; group: string };
  target?: { connId: string; name: string; namespace: string; dataId: string; group: string };
  selectedCount?: number;
  identical?: boolean;
  additions?: number;
  deletions?: number;
  changedKeys?: number;
  statusSummary?: Record<string, number>;
  summary?: {
    total: number;
    create: number;
    overwrite: number;
    delete: number;
    skip: number;
    parseError: number;
    blocked: number;
  };
  item?: {
    id: string;
    dataId: string;
    group: string;
    key?: string;
    action: string;
    blocked: boolean;
    blockReason?: string;
    sourceValue?: string;
    targetValue?: string;
    afterValue?: string;
  };
  result?: "success" | "failure";
  error?: string;
  dryRun?: boolean;
  backupSnapshotId?: string;
  /** 步骤标识：choose/compare/plan/execute/verify（与 DiffWorkflowCard 五步一致）。 */
  step?: string;
  /** 大 JSON 负载（字符串化）：items 完整内容、选中集、逐项 before/after 等。 */
  payload?: string;
}

interface AuditBridge {
  appendAuditEvent?: (payload: AuditEventPayload) => void;
}

export function appendAuditEvent(payload: Partial<AuditEventPayload>): void {
  const event: AuditEventPayload = {
    schema: AUDIT_EVENT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    kind: "unknown",
    ...payload,
  };
  try {
    const bridge = (window as Window & { __auditBridge?: AuditBridge }).__auditBridge;
    bridge?.appendAuditEvent?.(event);
  } catch {
    // 审计日志失败绝不影响主流程
  }
}

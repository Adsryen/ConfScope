// 应用执行安全合同：在真实写入前准备 before 备份和操作历史输入。
import type { ApplyPlan, ApplyPlanItem } from "./applyPlan";
import type { OperationRecord, OperationResult } from "../store/operationHistory";

export interface ApplyTargetBeforeSnapshot {
  itemId: string;
  namespace: string;
  group: string;
  dataId: string;
  exists: boolean;
  content?: string;
  configType?: string;
  updateTime?: string;
}

export interface ApplyBackupConfig {
  namespace: string;
  group: string;
  dataId: string;
  content: string;
  configType: string;
  updateTime: string;
}

export interface ApplyBackupCollection {
  configs: ApplyBackupConfig[];
  missingBeforeCount: number;
  missingItemIds: string[];
}

export interface ApplyBackupSummary {
  snapshotId?: string;
  snapshotName?: string;
  backedUpCount: number;
  missingBeforeCount: number;
}

export type ApplySafetyFailureReason = "plan_blocked" | "missing_before_snapshot" | "backup_failed";

export type ApplySafetyResult =
  | { ok: true; backup: ApplyBackupSummary; historyInput: Omit<OperationRecord, "id" | "timestamp"> }
  | {
      ok: false;
      reason: ApplySafetyFailureReason;
      error: string;
      historyInput: Omit<OperationRecord, "id" | "timestamp">;
    };

export interface ApplyExecutionSafetyDeps {
  createBackupSnapshot: (configs: ApplyBackupConfig[]) => Promise<{ id: string; name: string }>;
  taskId?: string;
  operator?: string;
}

interface BuildHistoryInputParams {
  result: OperationResult;
  backup: ApplyBackupSummary;
  taskId?: string;
  operator?: string;
  error?: string;
  beforeContent?: string;
}

export function operationTypeForApplyPlan(plan: Pick<ApplyPlan, "inputSummary">): "apply" | "promote" | "restore" {
  if (plan.inputSummary.sourceType === "promote") return "promote";
  if (plan.inputSummary.sourceType === "rollback") return "restore";
  return "apply";
}

function executableItems(plan: ApplyPlan): ApplyPlanItem[] {
  return plan.items.filter((item) => !item.blocked && item.action !== "skip" && item.action !== "parse_error");
}

function firstExecutableLocation(plan: ApplyPlan): Pick<OperationRecord, "group" | "dataId"> {
  const items = executableItems(plan);
  if (items.length === 1) {
    return {
      group: items[0].ref.group,
      dataId: items[0].ref.dataId,
    };
  }
  return {
    group: "*",
    dataId: "*",
  };
}

function planSummary(plan: ApplyPlan): NonNullable<OperationRecord["planSummary"]> {
  return {
    scope: plan.scope,
    total: plan.summary.total,
    create: plan.summary.create,
    overwrite: plan.summary.overwrite,
    delete: plan.summary.delete,
    skip: plan.summary.skip,
    parseError: plan.summary.parse_error,
    blocked: plan.summary.blocked,
    sourceLabel: plan.inputSummary.sourceLabel,
    targetLabel: plan.inputSummary.targetLabel,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function backupConfigFromSnapshot(item: ApplyPlanItem, snapshot: ApplyTargetBeforeSnapshot): ApplyBackupConfig | null {
  if (!snapshot.exists) return null;
  if (typeof snapshot.content !== "string") return null;
  return {
    namespace: item.ref.namespace,
    group: item.ref.group,
    dataId: item.ref.dataId,
    content: snapshot.content,
    configType: snapshot.configType || "text",
    updateTime: snapshot.updateTime || "",
  };
}

/** 收集真实写入前需要保存到 before 快照的目标内容。 */
export function collectApplyBackupConfigs(plan: ApplyPlan, beforeSnapshots: ApplyTargetBeforeSnapshot[]): ApplyBackupCollection {
  const beforeByItemId = new Map(beforeSnapshots.map((snapshot) => [snapshot.itemId, snapshot]));
  const configs: ApplyBackupConfig[] = [];
  const missingItemIds: string[] = [];
  let missingBeforeCount = 0;

  for (const item of executableItems(plan)) {
    const before = beforeByItemId.get(item.id);
    if (!before) {
      missingItemIds.push(item.id);
      continue;
    }

    const config = backupConfigFromSnapshot(item, before);
    if (config) {
      configs.push(config);
      continue;
    }

    if (before.exists) {
      missingItemIds.push(item.id);
    } else {
      missingBeforeCount += 1;
    }
  }

  return { configs, missingBeforeCount, missingItemIds };
}

/** 构造 apply 操作历史输入；调用方负责决定何时持久化。 */
export function buildApplyOperationHistoryInput(
  plan: ApplyPlan,
  params: BuildHistoryInputParams
): Omit<OperationRecord, "id" | "timestamp"> {
  const location = firstExecutableLocation(plan);
  return {
    type: operationTypeForApplyPlan(plan),
    result: params.result,
    connectionId: plan.target.connectionId,
    connectionName: plan.target.connectionName,
    namespace: plan.target.namespace || "public",
    group: location.group,
    dataId: location.dataId,
    beforeContent: params.beforeContent,
    planId: plan.id,
    planSummary: planSummary(plan),
    backupSnapshotId: params.backup.snapshotId,
    backupSnapshotName: params.backup.snapshotName,
    taskId: params.taskId,
    sourceConnectionId: plan.source.connectionId,
    sourceConnectionName: plan.source.connectionName,
    sourceNamespace: plan.source.namespace,
    targetConnectionId: plan.target.connectionId,
    targetConnectionName: plan.target.connectionName,
    targetNamespace: plan.target.namespace,
    error: params.error,
    operator: params.operator,
    rollbackable: false,
    rollbackReason: "operationHistory.rollbackApplyRequiresPlan",
  };
}

/** 执行前安全准备：任何阻断结果都表示后续执行器不能继续写入。 */
export async function prepareApplyExecutionSafety(
  plan: ApplyPlan,
  beforeSnapshots: ApplyTargetBeforeSnapshot[],
  deps: ApplyExecutionSafetyDeps
): Promise<ApplySafetyResult> {
  const blockedItems = plan.items.filter((item) => item.blocked);
  const emptyBackup: ApplyBackupSummary = { backedUpCount: 0, missingBeforeCount: 0 };
  if (blockedItems.length > 0) {
    const error = `Apply plan has ${blockedItems.length} blocked item(s).`;
    return {
      ok: false,
      reason: "plan_blocked",
      error,
      historyInput: buildApplyOperationHistoryInput(plan, {
        result: "failure",
        backup: emptyBackup,
        taskId: deps.taskId,
        operator: deps.operator,
        error,
      }),
    };
  }

  const collection = collectApplyBackupConfigs(plan, beforeSnapshots);
  if (collection.missingItemIds.length > 0) {
    const error = `Missing before snapshot for item(s): ${collection.missingItemIds.join(", ")}`;
    return {
      ok: false,
      reason: "missing_before_snapshot",
      error,
      historyInput: buildApplyOperationHistoryInput(plan, {
        result: "failure",
        backup: { backedUpCount: collection.configs.length, missingBeforeCount: collection.missingBeforeCount },
        taskId: deps.taskId,
        operator: deps.operator,
        error,
      }),
    };
  }

  try {
    const snapshot = collection.configs.length > 0 ? await deps.createBackupSnapshot(collection.configs) : undefined;
    const backup: ApplyBackupSummary = {
      snapshotId: snapshot?.id,
      snapshotName: snapshot?.name,
      backedUpCount: collection.configs.length,
      missingBeforeCount: collection.missingBeforeCount,
    };
    return {
      ok: true,
      backup,
      historyInput: buildApplyOperationHistoryInput(plan, {
        result: "success",
        backup,
        taskId: deps.taskId,
        operator: deps.operator,
        beforeContent: collection.configs.length === 1 ? collection.configs[0].content : undefined,
      }),
    };
  } catch (e) {
    const error = errorMessage(e);
    const backup: ApplyBackupSummary = {
      backedUpCount: collection.configs.length,
      missingBeforeCount: collection.missingBeforeCount,
    };
    return {
      ok: false,
      reason: "backup_failed",
      error,
      historyInput: buildApplyOperationHistoryInput(plan, {
        result: "failure",
        backup,
        taskId: deps.taskId,
        operator: deps.operator,
        error,
      }),
    };
  }
}

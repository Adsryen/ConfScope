// 直写入口的「计划出路」（轮42）。
//
// 背景：fd074a8 把直写在 API 层无条件砍掉了（`publishConfig` / `deleteConfig` 直接 throw），
//  sanctioned 的写入路径只剩变更计划执行器调用的 `publishConfigFromApplyPlan` / `deleteConfigFromApplyPlan`。
// 但浏览/编辑/历史四处 UI 入口当时没跟着改，于是变成「点一下必然失败、还留一条假失败审计」的死胡同。
//
// 本模块把这些入口改造成**同一套机制**的入口：用户想在这个位置得到什么内容，
// 就把它物化成 ApplyEntryPayload 的来源值（`items[].sourceValueOverride`），
// 交给已有的变更计划流程去 dry-run、确认、执行。不新增写路径、不放宽安全模型：
//   - 编辑正文 → 覆盖（来源=期望正文，目标=线上现值）
//   - 新建配置 → 新增（目标不存在）
//   - 删除配置 → 删除（期望内容 = 不存在，`classify()` 对 `!source.exists && target.exists` 给出 delete）
//   - 历史回滚 → 覆盖（来源=该历史版本正文）
// 先例与同一合同：`buildContentReplaceApplyEntry`（批量替换）、`buildRollbackEntryFromApplyRecord`（回退）。
import { type Connection } from "../store/connections";
import { connectionLabel } from "./defaultNameCopy";
import { applyEntryRiskSummary, type ApplyEntryEndpoint, type ApplyEntryPayload, type ApplyEntryRef } from "./applyEntry";
import { fingerprintApplyPlanValue, type ApplyPlanValueInput } from "./applyPlan";
import { detectFormat, type Format } from "./format";
import { normalizeConfig } from "./normalize";

const DOCUMENT_KEY = "__document";

/** 四个被禁用的直写意图；只影响 sourceType 与物化取值，不产生第二套写入机制。 */
export type DirectWriteIntent = "edit" | "create" | "delete" | "rollback";

export interface DirectWriteExitInput {
  conn: Connection;
  /** 计划里的连接名/端点标签是给人看的，内置默认名要按当前语言翻（见 lib/defaultNameCopy）。 */
  t: (key: string) => string;
  namespace: string;
  group: string;
  dataId: string;
  /** 正文格式；缺省时按 dataId 后缀与期望正文推断。 */
  format?: Format;
  /**
   * 期望这个位置最终是什么内容：
   * - 字符串：写入后的完整正文（编辑/新建/回滚）
   * - null：期望它不存在（删除）
   */
  desiredContent: string | null;
  intent: DirectWriteIntent;
}

/**
 * 这个连接能不能作为变更计划的目标（即有没有「出路」）。
 * 单出处：浏览页的编辑/删除/新建入口与历史回滚都据此决定按钮是否出现，
 * 免得只读连接继续挂着永远不可能成功的按钮。
 */
export function isWritableConfigTarget(conn: Connection): boolean {
  return conn.sourceType !== "local-snapshot" && !conn.readonly && (conn.provider ?? "nacos") === "nacos";
}

/**
 * 把「期望内容」物化成计划来源值快照。
 * 刻意不带 version/updateTime/md5：那是目标位置的服务器元数据，
 * 物化值只代表本地意图，冒充线上版本会让计划页把「本地草稿」显示成某个服务器版本。
 */
function desiredDocumentValue(ref: ApplyEntryRef, format: Format, desiredContent: string | null): ApplyPlanValueInput {
  if (desiredContent === null) {
    const absent: ApplyPlanValueInput = { exists: false, format };
    return { ...absent, fingerprint: fingerprintApplyPlanValue(ref, absent) };
  }
  const normalized = normalizeConfig(desiredContent, format);
  const value: ApplyPlanValueInput = {
    exists: true,
    value: desiredContent,
    valueType: "text",
    format,
    parseStatus: normalized.parseStatus,
    ...(normalized.parseError ? { parseError: normalized.parseError } : {}),
    content: desiredContent,
  };
  return { ...value, fingerprint: fingerprintApplyPlanValue(ref, value) };
}

/**
 * 生成「就地直写 → 变更计划」的入口载荷；不可写目标或缺 dataId 时返回 null（调用方据此不出现该入口）。
 *
 * source 与 target 是同一位置：计划的语义是「这个位置应该变成什么」，
 * freshness 基线取构建计划时实时读到的线上指纹（见 applyPlanDraft 的物化 override 特判），
 * 因此线上正文在计划生成后被别人改过时，执行会被判 stale 阻断，而不是覆盖掉对方的改动。
 */
export function buildDirectWriteExitEntry(input: DirectWriteExitInput): ApplyEntryPayload | null {
  const dataId = input.dataId.trim();
  if (!dataId) return null;
  if (!isWritableConfigTarget(input.conn)) return null;

  const conn = input.conn;
  const provider = conn.provider ?? "nacos";
  const connectionName = conn.name || connectionLabel(conn, input.t);
  const namespace = input.namespace;
  const group = input.group.trim() || "DEFAULT_GROUP";
  const format = input.format ?? detectFormat(dataId, "", input.desiredContent ?? "");

  const endpoint: ApplyEntryEndpoint = {
    provider,
    connectionId: conn.id,
    connectionName,
    namespace,
    label: `${connectionName} / ${namespace || "public"}`,
  };
  const ref: ApplyEntryRef = { provider, connectionId: conn.id, namespace, group, dataId, key: DOCUMENT_KEY };
  const item = {
    ...ref,
    sourceRef: ref,
    targetRef: ref,
    sourceValueOverride: desiredDocumentValue(ref, format, input.desiredContent),
  };
  const sourceType = input.intent === "rollback" ? "rollback" : "manual";

  return {
    sourceType,
    scope: "config",
    source: endpoint,
    target: endpoint,
    items: [item],
    rangeSummary: applyEntryRiskSummary([item]),
    // returnMode 恒为 browse：配置浏览的「历史变更」是页内 tab，App 的 "history" 模式是操作历史页，
    // 用 "history" 会把用户从正在看的配置里拽走。
    origin: { mode: sourceType, returnMode: "browse" },
  };
}

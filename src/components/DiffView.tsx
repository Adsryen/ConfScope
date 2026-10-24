import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ConfigItem, getConfig, listAllConfigs, listNamespaces, Namespace } from "../api/nacos";
import { detectFormat, Format } from "../lib/format";
import { environmentTone, environmentSortWeight, type EnvironmentTone } from "../lib/envTone";
import { revealArrival } from "../lib/arriveFlash";
import { diffLines } from "../lib/diff";
import { extractDuplicateKeys, normalizeConfig } from "../lib/normalize";
import { validateConfig } from "../lib/validate";
import { describeConfigListGaps, isStaleRequestError } from "../lib/configListStatus";
import { reportError, reportMessage } from "../lib/errorCenter";
import { keysDoc } from "../lib/keys";
import {
  Connection,
  connectionEnvironmentName,
  connectionProjectName,
  updateConnection,
} from "../store/connections";
import { connectionLabel, environmentLabel, localizeDefaultName, sourceLabel } from "../lib/defaultNameCopy";
import { useSettings } from "../lib/useSettings";
import { loadDiffViewPreferences, saveDiffViewPreferences, type DiffViewSourcePreference } from "../store/diffPreferences";
import { isCompleteDiffSourcePair, type DiffJumpParams } from "../lib/diffJump";
import { useTranslation } from "../i18n";
import { useWheelColumnResolver, useWheelSurface } from "../lib/useWheelColumnResolver";
import { exportDiff, type DiffItem } from "../lib/export";
import {
  applyEntryRiskSummary,
  type ApplyEntryEndpoint,
  type ApplyEntryItem,
  type ApplyEntryPayload,
  type ApplyEntryRef,
} from "../lib/applyEntry";
import Combobox from "./Combobox"
import { toast } from "../lib/toast";
import CopyButton from "./CopyButton";
import DiffPanel, { type MergeActionAvailability, type MergeActionDirection } from "./DiffPanel";
import DiffWorkflowCard, { type WorkflowStepId } from "./DiffWorkflowCard";
import Select from "./Select";
import TargetTunePanel, { type TargetTuneDraft } from "./TargetTunePanel";
import ConfirmModal from "./ConfirmModal";
import { createAuditSession, auditSessionEvent, endAuditSession, type AuditSession } from "../lib/auditSessionLog";
import { errorText } from "../lib/errorText";
import { statusMessageProps } from "../lib/statusSemantics";
import { MAX_DIFF_SEARCH_ITEMS, searchDiffContent } from "../lib/diffContentSearch";
import { highlightSearchTerm } from "../lib/configContentSearch";
import { EscapePriority, isImeComposing, useEscape } from "../lib/useEscape";
import { useDeferredSearchInput } from "../lib/deferredSearchInput";
import { changeTouchesNamespace, subscribeConfigChanges } from "../lib/configChangeBus";

type DiffMode = "text" | "key" | "lines";

interface Props {
  /**
   * 本页是不是真的可见（轮44 保活改造）。
   * App 的 `.diff-apply-cache` 现在切走只 hidden、不卸载，所以「看不见」和「没挂载」
   * 第一次不再是同一件事：隐藏期不许取数、不许报错弹 toast、不许抢焦点——
   * 常驻挂载不能变成后台轮询，这是 R2 的口径。缺省 true，非保活宿主按原语义渲染。
   * 因此可见性翻转本身不重取：隐藏期漏下的取数在切回可见时合并补做一次（见 SourcePicker
   * 的 pendingFetchRef），绕一趟浏览页回来仍是 0 次请求。
   */
  active?: boolean;
  connections: Connection[];
  onConnectionsChange?: (connections: Connection[]) => void;
  initialParams?: DiffJumpParams | null;
  onInitialParamsConsumed?: () => void;
  onStartApply?: (payload: ApplyEntryPayload) => void;
  /** 从变更计划页回退时的聚焦提示（stepper 导航） */
  focusStep?: WorkflowStepId | null;
  onFocusStepConsumed?: () => void;
  /**
   * 本次会话「退出时停在对比页」的一次性意图（轮46 R02）。App 只在首帧取一次值传下来，
   * 本组件挂载时用它 + prefs 里那一对是否齐全，决定要不要直接把上一对比出来。
   * 意图只活在 props 里，绝不进存储（轮45 R02 的口径）。
   */
  autoCompareOnRestore?: boolean;
}

/** 自动对比的现场快照：arm 时把「要拿哪一对去比」逐字段钉下来，ready 判定只比这份快照。 */
interface AutoCompareSnapshot {
  left: { connId: string; tenant: string; dataId: string; group: string };
  right: { connId: string; tenant: string; dataId: string; group: string };
}

function autoCompareSnapshotOf(left: Source, right: Source): AutoCompareSnapshot {
  return {
    left: { connId: left.connId, tenant: left.tenant, dataId: left.dataId, group: left.group },
    right: { connId: right.connId, tenant: right.tenant, dataId: right.dataId, group: right.group },
  };
}

interface Source {
  connId: string;
  tenant: string;
  dataId: string;
  group: string;
  usesDefaultNamespace: boolean;
}

interface Loaded {
  label: string;
  content: string;
  format: Format;
}

type MatchPresence = "both" | "left-only" | "right-only";

interface MatchResult {
  dataId: string;
  leftGroup: string;
  rightGroup: string;
  presence: MatchPresence;
}
interface BatchResult {
  dataId: string;
  leftLabel: string;
  rightLabel: string;
  leftText: string;
  rightText: string;
  format: Format;
  presence: MatchPresence;
}

interface MergePreviewText {
  leftText: string;
  rightText: string;
}

interface BatchResultStats {
  added: number;
  removed: number;
  modified: number;
}

type MergeSelectionDirection = MergeActionDirection;
type MergeSelectionScope = "row" | "block";

const DOCUMENT_KEY = "__document";

/**
 * 跨项内容搜索的输入落地延迟（轮55 C线）。
 *
 * 为什么不复用 lib/findInput 那套延迟：那套管的是**查找栏自己**那颗词（必须与命中计数、
 * 定位同帧，且只许三处调用，见 tests/ux/findInputDelaySingleSource）。这里的词是左栏列表的，
 * 它同时喂「列表命中表」和「右侧 diff 标红」两个消费者，而且两边读的是**同一个已提交值**，
 * 天然不会分叉，所以只需要把一串按键并成一次全量扫描。
 * 为什么是 150ms 而不是配置浏览那颗 400ms：那边每按一键要扇出上百次取正文的网络请求，
 * 这边扫的是已经在内存里的正文，等 400ms 会被读成「打了字没反应」。
 */
const CONTENT_SEARCH_DEBOUNCE_MS = 150;

function sortedLinesDoc(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() !== "")
    .sort()
    .join("\n");
}

function mergeSelectionKey(dataId: string, rowIndex: number): string {
  return `${dataId}::${rowIndex}`;
}

/**
 * 人工微调抽屉的草稿键（轮60 B线）。
 *
 * 草稿一律住在宿主 DiffView 而不是抽屉自己的 useState：以前编辑态挂在明细组件内部，
 * 切换选中项时不会重置，A 文件写了一半的正文会显示在 B 文件上，保存就把 A 的内容
 * 塞进 B 的计划（轮7 R60 钉过的坑）。按文件建键，切走再回来还是那一半正文。
 */
const SINGLE_TUNE_KEY = "diff:single";
const BATCH_TUNE_PREFIX = "diff:batch:";

function batchTuneKey(dataId: string): string {
  return `${BATCH_TUNE_PREFIX}${dataId}`;
}

function preferredNewline(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function materializeMergeText(
  leftText: string,
  rightText: string,
  direction: MergeSelectionDirection,
  selectedRowIndexes: Set<number>
): string {
  const rows = diffLines(leftText, rightText).rows;
  const output: string[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const selected = selectedRowIndexes.has(rowIndex);
    if (direction === "left-to-right") {
      if (row.type === "equal") output.push(row.right ?? row.left ?? "");
      else if (!selected && (row.type === "modify" || row.type === "add")) output.push(row.right ?? "");
      else if (selected && (row.type === "modify" || row.type === "del")) output.push(row.left ?? "");
      continue;
    }

    if (row.type === "equal") output.push(row.left ?? row.right ?? "");
    else if (!selected && (row.type === "modify" || row.type === "del")) output.push(row.left ?? "");
    else if (selected && (row.type === "modify" || row.type === "add")) output.push(row.right ?? "");
  }

  const baseText = direction === "left-to-right" ? rightText : leftText;
  const newline = preferredNewline(baseText);
  const merged = output.join(newline);
  return /\r?\n$/.test(baseText) && merged.length > 0 ? `${merged}${newline}` : merged;
}

function canMaterializeMerge(presence: MatchPresence, direction: MergeSelectionDirection): boolean {
  return direction === "left-to-right" && presence !== "right-only";
}

function mergeAvailabilityForPresence(presence: MatchPresence): MergeActionAvailability {
  return {
    "left-to-right": presence !== "right-only",
    "right-to-left": false,
  };
}

function mergePreviewForItem(item: BatchResult, previews: Record<string, MergePreviewText>): MergePreviewText {
  return previews[item.dataId] ?? { leftText: item.leftText, rightText: item.rightText };
}

function batchWarningsForItem(
  item: BatchResult,
  previews: Record<string, MergePreviewText>,
  t: (key: string, vars?: Record<string, string | number>) => string
): string[] {
  const preview = previews[item.dataId];
  if (!preview || item.format !== "YAML") return [];
  const warnings: string[] = [];
  const leftWarn = buildDuplicateKeyWarning(t, "diff.duplicateSideLeft", item.dataId, preview.leftText);
  const rightWarn = buildDuplicateKeyWarning(t, "diff.duplicateSideRight", item.dataId, preview.rightText);
  if (leftWarn) warnings.push(leftWarn);
  if (rightWarn) warnings.push(rightWarn);
  return warnings;
}

function mergePreviewChanged(item: BatchResult, preview: MergePreviewText, direction: MergeSelectionDirection): boolean {
  return direction === "left-to-right" ? preview.rightText !== item.rightText : preview.leftText !== item.leftText;
}

function duplicateKeyParts(
  duplicates: ReturnType<typeof extractDuplicateKeys>,
  t: (key: string) => string
): string {
  return duplicates
    .map((d) => `"${d.key}" @ ${t("diff.duplicateLine")} ${d.lineNumbers.join(", ")}`)
    .join("; ");
}

/** 重复 key 提示文案：哪个 key、出现在哪些行、处理方式与建议动作。 */
function buildDuplicateKeyWarning(t: (key: string, vars?: Record<string, string | number>) => string, sideKey: string, dataId: string, text: string): string | null {
  const duplicates = extractDuplicateKeys(text);
  if (duplicates.length === 0) return null;
  return t("diff.duplicateKeyWarning", {
    side: t(sideKey),
    dataId,
    parts: duplicateKeyParts(duplicates, t),
  });
}

function batchResultStats(leftText: string, rightText: string): BatchResultStats {
  const result = diffLines(leftText, rightText);
  return {
    added: result.added,
    removed: result.removed,
    modified: result.modified,
  };
}

function emptySource(connId: string, connections: Connection[] = []): Source {
  const conn = connections.find((item) => item.id === connId);
  const defaultGroup = (conn?.defaultGroup ?? "").trim();
  return {
    connId,
    tenant: conn?.defaultNamespace ?? "",
    dataId: "",
    group: defaultGroup || "DEFAULT_GROUP",
    usesDefaultNamespace: true,
  };
}

function syncDefaultNamespace(source: Source, connections: Connection[]): Source {
  const conn = connections.find((item) => item.id === source.connId);
  if (!conn) return source;
  const nextTenant = conn.defaultNamespace ?? "";
  if (!source.usesDefaultNamespace) return source;
  if (source.tenant === nextTenant) return source;
  return { ...source, tenant: nextTenant };
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.filter((item) => item.trim())));
}

function sortEnvironments(values: string[]): string[] {
  return [...values].sort((a, b) => {
    const byWeight = environmentSortWeight(a) - environmentSortWeight(b);
    return byWeight || compareText(a, b);
  });
}

function environmentHint(t: (key: string) => string, name: string): string {
  const keyByTone: Record<EnvironmentTone, string> = {
    dev: "diff.environmentHintDev",
    test: "diff.environmentHintTest",
    staging: "diff.environmentHintStaging",
    prod: "diff.environmentHintProd",
    canary: "diff.environmentHintCanary",
    local: "diff.environmentHintLocal",
    other: "diff.environmentHintOther",
  };
  return `${localizeDefaultName(name, t)} · ${t(keyByTone[environmentTone(name)])}`;
}

function EnvironmentBadge({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <span className={`env-badge env-${environmentTone(name)}`} title={environmentHint(t, name)}>
      {localizeDefaultName(name, t) || t("diff.environmentUnknown")}
    </span>
  );
}

function sourceSummary(source: Source, connections: Connection[], autoMatch: string, t: (key: string) => string): string {
  const conn = connections.find((item) => item.id === source.connId);
  const isLocal = conn?.sourceType === "local-snapshot";
  const path = conn ? sourceLabel(conn, t) : source.connId;
  const label = isLocal
    ? `${t("connection.sourceTypeSnapshot")} / ${path}`
    : conn
      ? `${environmentLabel(conn, t)} / ${path}`
      : source.connId;
  const namespace = source.tenant || "public";
  const group = source.group.trim() || "DEFAULT_GROUP";
  const dataId = source.dataId.trim() || autoMatch;
  return `${label} / ${namespace} / ${group} / ${dataId}`;
}

function applyEntryEndpointFromSource(
  source: Source,
  connections: Connection[],
  t: (key: string) => string
): ApplyEntryEndpoint | null {
  const conn = connections.find((item) => item.id === source.connId);
  if (!conn) return null;
  const namespace = source.tenant;
  const namespaceLabel = namespace || "public";
  return {
    provider: conn.provider ?? "nacos",
    connectionId: conn.id,
    connectionName: conn.name || conn.sourceName || conn.id,
    namespace,
    label: `${connectionLabel(conn, t)} / ${namespaceLabel}`,
  };
}

function applyEntryItemFromSource(source: Source, connections: Connection[], dataId: string, group: string): ApplyEntryRef | null {
  const conn = connections.find((item) => item.id === source.connId);
  if (!conn) return null;
  return {
    provider: conn.provider ?? "nacos",
    connectionId: conn.id,
    namespace: source.tenant,
    group: group.trim() || "DEFAULT_GROUP",
    dataId,
    key: DOCUMENT_KEY,
  };
}

function sourceOptionLabel(conn: Connection, t: (key: string) => string): string {
  const source = sourceLabel(conn, t);
  const remark = conn.name?.trim();
  return remark && remark !== source ? `${source} (${remark})` : source;
}

function chooseDefaultConnection(connections: Connection[], environment?: string): Connection | undefined {
  const candidates = environment ? connections.filter((conn) => connectionEnvironmentName(conn) === environment) : connections;
  return candidates.find((conn) => conn.isDefaultSource) ?? candidates[0] ?? connections[0];
}

interface InitialDiffState {
  selectedProject: string;
  left: Source;
  right: Source;
  mode: DiffMode;
}

function isDiffMode(value: unknown): value is DiffMode {
  return value === "text" || value === "key" || value === "lines";
}

function sourceFromPreference(source: DiffViewSourcePreference, connections: Connection[]): Source | null {
  const conn = connections.find((item) => item.id === source.connId);
  if (!conn) return null;
  const usesDefaultNamespace = source.usesDefaultNamespace;
  return {
    connId: conn.id,
    tenant: usesDefaultNamespace ? (conn.defaultNamespace ?? "") : source.tenant,
    dataId: source.dataId,
    group: source.group.trim() || "DEFAULT_GROUP",
    usesDefaultNamespace,
  };
}

function defaultInitialDiffState(connections: Connection[]): InitialDiffState {
  const firstId = connections[0]?.id ?? "";
  const firstProject = connections[0] ? connectionProjectName(connections[0]) : "";
  return {
    selectedProject: firstProject,
    left: emptySource(firstId, connections),
    right: emptySource(firstId, connections),
    mode: "text",
  };
}

function initialDiffStateFromPreferences(connections: Connection[]): InitialDiffState {
  const fallback = defaultInitialDiffState(connections);
  if (connections.length === 0) return fallback;
  const preferences = loadDiffViewPreferences();
  const left = sourceFromPreference(preferences.left, connections);
  const right = sourceFromPreference(preferences.right, connections);
  if (!left || !right) return fallback;
  const leftConn = connections.find((item) => item.id === left.connId);
  const rightConn = connections.find((item) => item.id === right.connId);
  if (!leftConn || !rightConn) return fallback;
  const leftProject = connectionProjectName(leftConn);
  const rightProject = connectionProjectName(rightConn);
  if (!leftProject || leftProject !== rightProject) return fallback;
  return {
    selectedProject: leftProject,
    left,
    right,
    mode: isDiffMode(preferences.mode) ? preferences.mode : "text",
  };
}

function SourcePicker({
  title,
  active = true,
  connections,
  projectConnections,
  source,
  onChange,
  onSetDefaultNamespace,
  onLoadError,
  sortConnections,
  sortNamespaces,
}: {
  title: string;
  /** 宿主对比页是否可见：隐藏期两侧来源面板都不取数（见 Props.active 的口径）。 */
  active?: boolean;
  connections: Connection[];
  projectConnections: Connection[];
  source: Source;
  onChange: (source: Source) => void;
  onSetDefaultNamespace?: (connId: string, namespace: string) => void;
  onLoadError?: () => void;
  /**
   * 连接下拉是否按名称排序（轮72 R-B9）。设置页这一条开关从写下那天起没有任何地方读它，
   * 取消勾选后下拉照样是排的：关掉时保持连接里的原始顺序（那是用户自己排的优先级）。
   */
  sortConnections: boolean;
  sortNamespaces: boolean;
}) {
  const { t } = useTranslation();
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [nsLoading, setNsLoading] = useState(false);
  const [nsError, setNsError] = useState<string | null>(null);
  const [nsReload, setNsReload] = useState(0);
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [cfgLoading, setCfgLoading] = useState(false);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [cfgReload, setCfgReload] = useState(0);
  // 聚合翻页期间的已取条数与「结果不完整」提示（命中安全上限 / 有页失败）
  const [cfgLoaded, setCfgLoaded] = useState(0);
  const [cfgGaps, setCfgGaps] = useState<string[]>([]);
  const onLoadErrorRef = useRef(onLoadError);
  /**
   * 隐藏期欠下的取数（轮44 R2）：与浏览页 `.browse-cache` 的 `pendingStaleRef` 同一套契约——
   * 看不见时只记一笔账、不发请求，切回可见时合并补做。
   *
   * `active` 绝不能进下面两个 effect 的依赖：可见性一翻转就重取 = 每绕一趟浏览页都要把两侧
   * 命名空间与 dataId 候选重新打一遍（DK-01 实测 4 次请求），而这正是本轮要消灭的东西。
   * 反过来只 `return` 不记账也不行：隐藏期连接被编辑过（`conn` 换了对象）就再没人补这一取，
   * 切回来挂的是上一个连接的候选列表。
   */
  const activeRef = useRef(active);
  const pendingFetchRef = useRef(false);
  useEffect(() => {
    activeRef.current = active;
    if (!active || !pendingFetchRef.current) return;
    pendingFetchRef.current = false;
    setNsReload((value) => value + 1);
    setCfgReload((value) => value + 1);
  }, [active]);

  const conn = connections.find((item) => item.id === source.connId);
  const isLocalSnapshot = conn?.sourceType === "local-snapshot";
  const snapshotPath = conn?.localPath || conn?.baseUrl || "";
  const selectedEnvironment = conn ? connectionEnvironmentName(conn) : "";
  const environmentNames = sortEnvironments(uniqueValues(projectConnections.map((item) => connectionEnvironmentName(item))));
  const environmentOptions = environmentNames.map((value) => ({ value, label: localizeDefaultName(value, t) }));
  const sourceConnections = selectedEnvironment
    ? projectConnections.filter((item) => connectionEnvironmentName(item) === selectedEnvironment)
    : projectConnections;
  // 排序判据（轮72 R-B9）：只有勾选时才排，未勾选保持传入顺序
  const orderedSourceConnections = sortConnections
    ? [...sourceConnections].sort((a, b) => compareText(sourceOptionLabel(a, t), sourceOptionLabel(b, t)))
    : sourceConnections;
  const sourceOptions = orderedSourceConnections.map((item) => ({ value: item.id, label: sourceOptionLabel(item, t) }));

  useEffect(() => {
    if (!conn) return;
    if (!activeRef.current) {
      pendingFetchRef.current = true;
      return;
    }
    let alive = true;
    setNsLoading(true);
    setNsError(null);
    setNamespaces([]);

    listNamespaces(conn)
      .then((items) => {
        if (alive) setNamespaces(items);
      })
      .catch((e) => {
        if (!alive) return;
        const message = errorText(e);
        setNamespaces([]);
        setNsError(message);
        onLoadErrorRef.current?.();
        reportError({
          title: t("diff.namespaceLoadFailed"),
          source: conn ? `${connectionLabel(conn, t)} / ${title}` : title,
          message,
          detail: message,
          mergeKey: `diff:namespace:${conn?.id || source.connId}`,
          actionLabel: t("common.retry"),
          onAction: () => setNsReload((value) => value + 1),
        });
      })
      .finally(() => {
        if (alive) setNsLoading(false);
      });

    return () => {
      alive = false;
    };
  // active 不入依赖：隐藏期的依赖变化由 pendingFetchRef 记账，切回可见时补做（见上方注释）
  }, [conn, nsReload, source.connId, t, title]);

  useEffect(() => {
    if (!conn) return;
    if (!activeRef.current) {
      pendingFetchRef.current = true;
      return;
    }
    let alive = true;
    setCfgLoading(true);
    setCfgError(null);
    setConfigs([]);
    setCfgLoaded(0);
    setCfgGaps([]);

    // group 传空 → 该命名空间全部 group；按 pagesAvailable 取全，超过安全上限时显式提示
    listAllConfigs(conn, source.tenant, "", "", {
      pageSize: 1000,
      isStale: () => !alive,
      onProgress: (loaded) => setCfgLoaded(loaded),
    })
      .then((result) => {
        if (!alive) return;
        // 客户端精确过滤：Nacos v1 的 group=空 可能混入大小写不同的兄弟 group，
        // 只保留与当前选中 group 精确匹配（忽略大小写）的配置项。
        const expected = (source.group || "").trim().toLowerCase();
        const items = expected
          ? result.items.filter((item) => (item.group || "").trim().toLowerCase() === expected)
          : result.items;
        setConfigs(items);
        setCfgGaps(describeConfigListGaps(result, t));
      })
      .catch((e) => {
        // 请求作废（切连接/命名空间/group）是内部取消信号，静默丢弃
        if (!alive || isStaleRequestError(e)) return;
        const message = errorText(e);
        setConfigs([]);
        setCfgError(message);
        onLoadErrorRef.current?.();
        reportError({
          title: t("diff.configListLoadFailed"),
          source: conn ? `${connectionLabel(conn, t)} / ${source.tenant || "public"} / ${title}` : title,
          message,
          detail: message,
          mergeKey: `diff:configs:${conn?.id || source.connId}:${source.tenant || "public"}`,
          actionLabel: t("common.retry"),
          onAction: () => setCfgReload((value) => value + 1),
        });
      })
      .finally(() => {
        if (alive) setCfgLoading(false);
      });

    return () => {
      alive = false;
    };
  // source.group 必须入依赖：否则清空/输入 group 后不会重新拉取候选，group 下拉无法枚举该命名空间全部 group
  }, [cfgReload, conn, source.connId, source.tenant, source.group, t, title]);

  const namespaceItems = namespaces
    .filter((item) => item.namespace)
    .sort((a, b) => (sortNamespaces ? compareText(a.namespaceShowName || a.namespace, b.namespaceShowName || b.namespace) : 0));
  const namespaceOptions = [
    { value: "", label: t("app.namespaceDefault") },
    ...namespaceItems.map((item) => ({ value: item.namespace, label: item.namespaceShowName || item.namespace })),
  ];
  const canSetDefaultNamespace = !!conn && conn.sourceType !== "local-snapshot" && source.tenant !== (conn.defaultNamespace ?? "");
  const dataIdOptions = configs.map((item) => ({ value: item.dataId, sub: item.group }));
  // 全量枚举该命名空间下的 group（不传 group 过滤，否则非默认 group 永远选不到）
  const groupOptions = Array.from(new Set(configs.map((item) => item.group))).filter(Boolean).map((value) => ({ value }));

  useEffect(() => {
    onLoadErrorRef.current = onLoadError;
  }, [onLoadError]);

  return (
    <div className={`source-picker${isLocalSnapshot ? " local-source" : ""}`}>
      <div className="source-title-row">
        <div className="source-title">
          {title}
          {selectedEnvironment && <EnvironmentBadge name={selectedEnvironment} />}
        </div>
        <div className="source-kind-wrap">
          <span className={`source-kind${isLocalSnapshot ? " local" : ""}`}>
            {isLocalSnapshot ? t("connection.sourceTypeSnapshot") : t("connection.sourceTypeNacos")}
          </span>
        </div>
      </div>

      <div className="field-row">
        <label className="field">
          <span>{t("connection.environment")}</span>
          <Select
            className="wide"
            value={selectedEnvironment}
            options={environmentOptions}
            onChange={(value) => {
              const nextConn = chooseDefaultConnection(projectConnections, value);
              if (nextConn) onChange(emptySource(nextConn.id, connections));
            }}
          />
        </label>
        <label className="field">
          <span>{t("diff.sourceEntry")}</span>
          <Select
            className="wide"
            value={source.connId}
            options={sourceOptions}
            onChange={(value) => onChange(emptySource(value, connections))}
          />
        </label>
      </div>

      {isLocalSnapshot && (
        <div className="source-note">
          <span>{t("diff.localSnapshotHint")}</span>
          <strong title={snapshotPath}>{snapshotPath}</strong>
        </div>
      )}

      <label className="field">
        <span>
          {t("app.namespace")}{" "}
          <span role="status" aria-live="polite">
            {nsLoading ? `(${t("common.loading")})` : ""}
          </span>
        </span>
        <div className="namespace-pick-row">
          <Select
            className="wide"
            value={source.tenant}
            options={namespaceOptions}
            onChange={(value) => onChange({ ...source, tenant: value, usesDefaultNamespace: false })}
          />
          {onSetDefaultNamespace && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!canSetDefaultNamespace}
              onClick={() => onSetDefaultNamespace(source.connId, source.tenant)}
            >
              {t("diff.setDefaultNamespace")}
            </button>
          )}
        </div>
        {nsError && (
          <div className="field-error-box" {...statusMessageProps("error")}>
            <span className="field-error">
              {t("diff.namespaceLoadFailed")}: {nsError}
            </span>
            <div className="field-error-actions">
              <button type="button" className="btn btn-ghost btn-sm" disabled={nsLoading} onClick={() => setNsReload((value) => value + 1)}>
                {t("diff.retryNamespaces")}
              </button>
              <CopyButton text={`${t("diff.namespaceLoadFailed")}: ${nsError}`} label={t("diff.copyError")} />
            </div>
          </div>
        )}
      </label>

      <div className="field-row">
        <label className="field">
          <span>
            dataId{" "}
            <span role="status" aria-live="polite">
              {cfgLoading ? `(${t("common.loading")} ${t("diff.configListLoaded", { count: cfgLoaded })})` : `(${configs.length})`}
            </span>
          </span>
          {/* 轮67 R67-WP9：这只 label 里还坐着「重试配置列表」与复制键，
              label 的文字会被并进输入框的可访问名（读屏念成「dataId (3) 重试配置列表 复制错误…」）。
              显式给名字，取可见标题那句 "dataId"（WCAG 2.5.3 要求名字含可见文字）。 */}
          <Combobox
            value={source.dataId}
            ariaLabel="dataId"
            placeholder={t("diff.dataIdPlaceholder")}
            options={dataIdOptions}
            onChange={(value) => onChange({ ...source, dataId: value })}
            onPick={(option) => onChange({ ...source, dataId: option.value, group: option.sub || source.group })}
          />
          {cfgError && (
            <div className="field-error-box" {...statusMessageProps("error")}>
              <span className="field-error">
                {t("diff.configListLoadFailed")}: {cfgError}
              </span>
              <div className="field-error-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={cfgLoading}
                  onClick={() => setCfgReload((value) => value + 1)}
                >
                  {t("diff.retryConfigs")}
                </button>
                <CopyButton text={`${t("diff.configListLoadFailed")}: ${cfgError}`} label={t("diff.copyError")} />
              </div>
            </div>
          )}
          {cfgGaps.length > 0 && (
            <div className="diff-warnings" {...statusMessageProps("info")}>
              {cfgGaps.map((gap) => (
                <div className="diff-warning" key={gap}>
                  {gap}
                </div>
              ))}
              <div className="field-error-actions">
                <CopyButton text={cfgGaps.join("\n")} label={t("diff.copyError")} />
              </div>
            </div>
          )}
        </label>

        <label className="field">
          <span>{t("config.groupFilter")}</span>
          <Combobox
            value={source.group}
            placeholder={t("diff.groupPlaceholder")}
            options={groupOptions}
            onChange={(value) => {
              // 空 group 保持为空：允许用户清空后枚举该命名空间全部 group；
              // 真正提交/加载时才回退到 DEFAULT_GROUP（见 loadOne / 加载 effect）。
              const group = value.trim();
              const next = { ...source, group };
              // 输入过程中的部分匹配不清空已选 dataId，避免边打边丢候选；
              // 只有"选中"一个具体 group 且 dataId 不属于该 group 时才清空。
              onChange(next);
            }}
            onPick={(option) => {
              const group = option.value.trim() || "DEFAULT_GROUP";
              const next = { ...source, group };
              if (next.dataId) {
                const inGroup = configs.some((item) => item.dataId === next.dataId && item.group === group);
                if (!inGroup) next.dataId = "";
              }
              onChange(next);
            }}
          />
        </label>
      </div>
    </div>
  );
}

export default function DiffView({ active = true, connections, onConnectionsChange, initialParams, onInitialParamsConsumed, onStartApply, focusStep, onFocusStepConsumed, autoCompareOnRestore = false }: Props) {
  const { t } = useTranslation();
  const settings = useSettings();
  const initialDiffStateRef = useRef<InitialDiffState | null>(null);
  if (!initialDiffStateRef.current) initialDiffStateRef.current = initialDiffStateFromPreferences(connections);
  const [selectedProject, setSelectedProject] = useState(initialDiffStateRef.current.selectedProject);
  const [left, setLeft] = useState<Source>(initialDiffStateRef.current.left);
  const [right, setRight] = useState<Source>(initialDiffStateRef.current.right);
  const [leftLoaded, setLeftLoaded] = useState<Loaded | null>(null);
  const [rightLoaded, setRightLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leftFailed, setLeftFailed] = useState(false);
  const [rightFailed, setRightFailed] = useState(false);
  const [mode, setMode] = useState<DiffMode>(initialDiffStateRef.current.mode);
  const [matchResults, setMatchResults] = useState<MatchResult[] | null>(null);
  const [matchLoading, setMatchLoading] = useState(false);
  // 批量对比取列表的进度与「结果不完整」提示（任一侧截断/少页都要显示）
  const [matchScan, setMatchScan] = useState(0);
  const [matchGaps, setMatchGaps] = useState<string[]>([]);
  const matchReqId = useRef(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchResults, setBatchResults] = useState<BatchResult[]>([]);
  const [selectedBatchDataId, setSelectedBatchDataId] = useState<string | null>(null);
  const [failedItems, setFailedItems] = useState<{ dataId: string; error: string; leftGroup: string; rightGroup: string }[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchOnlyChanges, setBatchOnlyChanges] = useState<Set<string>>(new Set());
  const [mergeSelections, setMergeSelections] = useState<Record<string, MergeSelectionDirection>>({});
  const [mergePreviews, setMergePreviews] = useState<Record<string, MergePreviewText>>({});
  const [mergeSelectionScope, setMergeSelectionScope] = useState<MergeSelectionScope>("block");
  /**
   * 第三步「人工微调右侧目标内容」（轮60 B线）。
   * - tuneEditingKey：当前哪一块处于编辑态（同一时刻只编辑一份正文）。
   * - tuneDrafts：编辑中的正文 + 行内错误，按文件存。
   * - singleTune：单配置模式**已保存**的微调文本。批量模式的已保存文本就是
   *   mergePreviews 的 rightText，不另开一份——同一份「将写入什么」不许有两个来源。
   * - tunedDataIds：哪些文件被手写过。挑块合并与人工微调都带 sourceValueOverride，
   *   计划里只能靠这个标记区分两者（R4 可追溯）。
   */
  const [tuneEditingKey, setTuneEditingKey] = useState<string | null>(null);
  const [tuneDrafts, setTuneDrafts] = useState<Record<string, TargetTuneDraft>>({});
  const [singleTune, setSingleTune] = useState<TargetTuneDraft | null>(null);
  const [tunedDataIds, setTunedDataIds] = useState<Set<string>>(new Set());
  const [tuneNotice, setTuneNotice] = useState<string | null>(null);
  /**
   * 待确认的微调丢弃（轮60 R7）：还原 = 永久丢掉手写的正文，按本项目口径必须先问一句
   * （与 ConfigBrowser 的 guardNav、第四步的 discardEdits 同一不变式）。
   * 收起抽屉不走这里——那条路不销毁草稿。
   */
  const [tuneDiscardPending, setTuneDiscardPending] = useState<{ scope: "single" | "batch"; dataId: string } | null>(null);
  /**
   * 跨项内容搜索（轮55 C线）：input 是框里的即时值，term 是落进命中层的那一颗。
   * 分两颗是因为扫描要吃整批正文（不能每键一次），而 diff 标红必须与列表同一帧说同一句话。
   */
  const [contentSearchInput, setContentSearchInput] = useState("");
  const [contentSearchTerm, setContentSearchTerm] = useState("");
  const [onlyHitItems, setOnlyHitItems] = useState(false);
  /**
   * 跨项内容搜索的输入编排：防抖 150ms + 输入法闸门（轮66 WP-6）。
   *
   * 原来这里是一层裸 setTimeout，组合期间每敲一个拼音字母都会派发 input，
   * 于是「备份」会先拿 b / be / bei 各扫一遍全量正文——命中表闪成空，右侧标红也跟着抖。
   * 回显（contentSearchInput）永远即时，落地词（contentSearchTerm）等上屏再说。
   */
  const {
    schedule: scheduleContentSearch,
    runNow: runContentSearchNow,
    cancel: cancelContentSearchTimer,
    onCompositionStart: onContentSearchCompositionStart,
    onCompositionEnd: onContentSearchCompositionEnd,
  } = useDeferredSearchInput(
    (value: string) => setContentSearchTerm(value.trim()),
    CONTENT_SEARCH_DEBOUNCE_MS
  );
  const contentSearchInputRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 写后失效：计划执行改的是服务端，而本页被 `.diff-apply-cache` 保活，切回来时面板里的
  // 差异统计仍是执行前那一刻。对比是重操作、也不该被自动打断，所以只标记过期 + 给一键重比。
  const [resultStale, setResultStale] = useState(false);
  const [sourcesCollapsed, setSourcesCollapsed] = useState(false);
  const [pendingAutoCompare, setPendingAutoCompare] = useState<AutoCompareSnapshot | null>(null);
  // 恢复路径只在本组件挂载时决定一次（轮46）：prop 后续再怎么变都不该重新点亮自动比。
  const restoreCheckedRef = useRef(false);
  /** 已经应用过的跳转参数（按对象引用）。见下面「处理从 AuditView 跳转过来的预填参数」的注释。 */
  const appliedJumpParamsRef = useRef<DiffJumpParams | null>(null);
  /**
   * 滚轮兜底（轮33 F-34）：根取 `.diff-workspace` 而不是 `.diff-view`——`.page-header` 就在
   * DiffView 自己的 return 里、语义上「不属于任何一列」，本轮按 PRD 划入禁区不接。
   * 宽栏实测（research/p3_batch_match_chrome.txt）：单文件态 5 条 chrome、批量态 6 条、匹配态 3 条
   * 全是一动不动的死区（页内死区 28.3%–29.6% 视口），而窄栏 900×700 两态全 OK——差别只在
   * chrome 的祖先链里有没有可滚容器。所以这里只登记「谁可以被滚」，选谁交给几何。
   */
  const workspaceRef = useRef<HTMLDivElement>(null);
  const batchNavScrollRef = useRef<HTMLDivElement>(null);
  const matchLeftScrollRef = useRef<HTMLDivElement>(null);
  const matchRightScrollRef = useRef<HTMLDivElement>(null);
  useWheelColumnResolver(workspaceRef);
  useWheelSurface(batchNavScrollRef);
  useWheelSurface(matchLeftScrollRef);
  useWheelSurface(matchRightScrollRef);
  const sourcesRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const loadBothRef = useRef<(() => Promise<void>) | null>(null);
  const auditSessionRef = useRef<AuditSession | null>(null);
  const projectNames = useMemo(
    () => [...uniqueValues(connections.map((item) => connectionProjectName(item)))].sort((a, b) => compareText(a, b)),
    [connections]
  );
  const activeProject = projectNames.includes(selectedProject) ? selectedProject : (projectNames[0] ?? "");
  const projectConnections = useMemo(
    () => connections.filter((item) => connectionProjectName(item) === activeProject),
    [connections, activeProject]
  );
  // 项目下拉：value 是存档里的 raw 名（切换项目靠它匹配），label 才本地化。
  const projectOptions = useMemo(
    () => projectNames.map((value) => ({ value, label: localizeDefaultName(value, t) })),
    [projectNames, t]
  );

  useEffect(() => {
    if (!activeProject) return;
    const leftConn = connections.find((item) => item.id === left.connId);
    const rightConn = connections.find((item) => item.id === right.connId);
    if (!leftConn || !rightConn) return;
    if (connectionProjectName(leftConn) !== activeProject || connectionProjectName(rightConn) !== activeProject) return;
    saveDiffViewPreferences({
      selectedProject: activeProject,
      left,
      right,
      mode,
    });
  }, [activeProject, connections, left, mode, right]);

  /**
   * 搜索作用域 = 这批**已加载**的对比正文（原样取左右正文，不掺合并预览草稿）：
   * 草稿是「还没决定的事」，命中数不能建立在用户随时会撤的改动上。
   */
  const batchSearchItems = useMemo(
    () => batchResults.map((item) => ({ dataId: item.dataId, leftText: item.leftText, rightText: item.rightText })),
    [batchResults]
  );
  const diffSearch = useMemo(() => searchDiffContent(batchSearchItems, contentSearchTerm), [batchSearchItems, contentSearchTerm]);
  const diffSearchHitsById = useMemo(() => new Map(diffSearch.hits.map((hit) => [hit.dataId, hit])), [diffSearch]);
  const isContentSearchActive = Boolean(diffSearch.term);
  const visibleBatchResults =
    isContentSearchActive && onlyHitItems
      ? batchResults.filter((item) => diffSearchHitsById.has(item.dataId))
      : batchResults;

  /**
   * 清空跨项内容搜索（词、过滤、待落地的定时器一起归零）。
   *
   * 收成一个动作而不是「顺手 setState 两下」：定时器留着的话，用户清完 150ms 后
   * 旧词会把列表重新打回过滤态——与配置浏览 clearSearchTerms 钉过的同款坑。
   */
  const clearContentSearch = useCallback(() => {
    cancelContentSearchTimer();
    setContentSearchInput("");
    setContentSearchTerm("");
    setOnlyHitItems(false);
  }, [cancelContentSearchTimer]);

  /**
   * 微调状态整体归零：换来源、重新对比、回到匹配列表都必须走这里。
   *
   * 手写正文的基线是「这一次对比的右侧长什么样」。基线一换，草稿和「哪些文件被手写过」
   * 就全部失去意义，留着等于把上一轮的文本带进下一轮的计划。
   */
  const resetTuneState = useCallback(() => {
    setTuneEditingKey(null);
    setTuneDrafts({});
    setSingleTune(null);
    setTunedDataIds(new Set());
    setTuneNotice(null);
    setTuneDiscardPending(null);
  }, []);

  /** 只清批量侧的微调痕迹（「重置预览」按钮用）：单配置那颗微调结果与此无关，不能顺手抹掉。 */
  const resetBatchTuneDrafts = useCallback(() => {
    setTuneEditingKey((current) => (current && current.startsWith(BATCH_TUNE_PREFIX) ? null : current));
    setTuneDrafts((current) => {
      const next: Record<string, TargetTuneDraft> = {};
      let changed = false;
      for (const [key, draft] of Object.entries(current)) {
        if (key.startsWith(BATCH_TUNE_PREFIX)) {
          changed = true;
          continue;
        }
        next[key] = draft;
      }
      return changed ? next : current;
    });
    setTunedDataIds(new Set());
    setTuneNotice(null);
  }, []);

  const onContentSearchChange = (value: string) => {
    setContentSearchInput(value);
    scheduleContentSearch(value);
  };

  /**
   * Esc 收起跨项内容搜索：清空词与过滤，焦点留在框里继续打。
   *
   * 走 useEscape 而不是 onKeyDown 里判 key === "Escape"（轮16 R61 的口径，守卫
   * tests/ux/transientEditorsOwnEscape 钉死）：分派器挂在 window 捕获阶段并 stopPropagation，
   * 裸分支在任意一层注册时都是死代码。
   * 档位选 page 而不是 find 是有意的：find 档专门给「宿主弹层内部的瞬时查找层」，
   * 而这一层和右侧 diff 的查找栏同为页面内层——父组件的注册在子组件之后生效，
   * 同档比注册序，页面层反而会把子层查找栏的 Esc 抢走。挂 page 后差异正文的
   * 查找栏（find=15）永远优先，关完它才轮到这一层收搜索框。
   */
  const closeContentSearch = useCallback(() => {
    clearContentSearch();
    contentSearchInputRef.current?.focus();
  }, [clearContentSearch]);
  // 框里没字就没什么可收的；页面被保活隐藏时（active=false）绝不参与分派。
  useEscape(active && Boolean(contentSearchInput), closeContentSearch, EscapePriority.page);

  /** Enter = 立刻落地并跳到第一个命中项（Esc 不在此处，见上面 closeContentSearch）。 */
  const onContentSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // 输入法组合态：回车还在选候选词，不能当成「提交搜索」
    if (isImeComposing(event)) return;
    if (event.key === "Enter") {
      const term = event.currentTarget.value.trim();
      // Enter 是明确的提交：收掉待落地的排期，并用当前词立即落地一次。
      runContentSearchNow(term);
      // 不等这一帧之后的 memo：直接用同一个词现算一次，否则 Enter 会按旧词的命中表跳。
      const first = searchDiffContent(batchSearchItems, term).hits[0];
      if (first) setSelectedBatchDataId(first.dataId);
    }
  };

  const resetComparisonState = useCallback(() => {
    setMatchResults(null);
    setBatchResults([]);
    setSelectedBatchDataId(null);
    setFailedItems([]);
    setSelectedIds(new Set());
    setBatchOnlyChanges(new Set());
    setMergeSelections({});
    setMergePreviews({});
    resetTuneState();
    setLeftLoaded(null);
    setRightLoaded(null);
    setLeftFailed(false);
    setRightFailed(false);
    setNotice(null);
    clearContentSearch();
  }, [clearContentSearch, resetTuneState]);

  useEffect(() => {
    if (batchResults.length === 0) {
      setSelectedBatchDataId(null);
      return;
    }
    setSelectedBatchDataId((current) => {
      if (current && batchResults.some((item) => item.dataId === current)) return current;
      return batchResults[0]?.dataId ?? null;
    });
  }, [batchResults]);

  useEffect(() => {
    if (selectedProject !== activeProject) {
      setSelectedProject(activeProject);
      return;
    }
    if (!activeProject || projectConnections.length === 0) return;
    const leftInProject = projectConnections.some((item) => item.id === left.connId);
    const rightInProject = projectConnections.some((item) => item.id === right.connId);
    if (leftInProject && rightInProject) return;

    const fallback = chooseDefaultConnection(projectConnections);
    if (!fallback) return;
    resetComparisonState();
    setSourcesCollapsed(false);
    if (!leftInProject) setLeft(emptySource(fallback.id, connections));
    if (!rightInProject) setRight(emptySource(fallback.id, connections));
  }, [activeProject, connections, left.connId, projectConnections, resetComparisonState, right.connId, selectedProject]);

  useEffect(() => {
    const nextLeft = syncDefaultNamespace(left, connections);
    const nextRight = syncDefaultNamespace(right, connections);
    if (nextLeft !== left || nextRight !== right) {
      resetComparisonState();
      setSourcesCollapsed(false);
      setLeft(nextLeft);
      setRight(nextRight);
    }
  }, [connections, left, resetComparisonState, right]);

  useEffect(() => {
    const node = sourcesRef.current;
    if (!node) return;
    if (sourcesCollapsed) node.setAttribute("inert", "");
    else node.removeAttribute("inert");
  }, [sourcesCollapsed]);

  // 处理从 AuditView 跳转过来的预填参数
  useEffect(() => {
    if (!initialParams) return;
    // 同一份跳转参数只应用一次（轮44 R90：实测这个 effect 不幂等）。App 水合主数据文件会把
    // `connections` 换成新数组，而 `initialParams` 要等 onInitialParamsConsumed 落回 App 才变 null——
    // 这一帧的间隔里本 effect 会重跑，重跑有两条副作用：再收起一次来源面板（用户刚展开又自己折回去）
    // + 再排一次自动对比（多付一趟取数）。jsdom 回归见 DiffView.test.tsx「启动自动对比的幂等」：
    // 换 connections 引用、同一份 params，getConfig 必须仍是 2 次（加守卫前实测 4 次）。
    if (appliedJumpParamsRef.current === initialParams) return;
    appliedJumpParamsRef.current = initialParams;
    const leftConn = connections.find((c) => c.id === initialParams.leftConnId);
    const rightConn = connections.find((c) => c.id === initialParams.rightConnId);
    if (!leftConn || !rightConn) {
      onInitialParamsConsumed?.();
      return;
    }
    // 设置项目
    const projectName = connectionProjectName(leftConn);
    setSelectedProject(projectName);
    // 预填左右来源：左右各自独立的 namespace/group/dataId。
    // 未指定的一侧回退到该连接配置的默认 namespace（而非用对侧的 namespace，
    // 否则会在右连接上查到空列表，group 下拉与 dataId 候选全空）。
    const prefGroup = (side?: { group?: string } | null) => (side?.group ?? "").trim() || "DEFAULT_GROUP";
    const nextLeft: Source = {
      connId: initialParams.leftConnId,
      tenant: initialParams.left?.tenant ?? leftConn.defaultNamespace ?? "",
      dataId: initialParams.left?.dataId ?? "",
      group: prefGroup(initialParams.left),
      usesDefaultNamespace: false,
    };
    const nextRight: Source = {
      connId: initialParams.rightConnId,
      tenant: initialParams.right?.tenant ?? rightConn.defaultNamespace ?? "",
      dataId: initialParams.right?.dataId ?? "",
      group: prefGroup(initialParams.right),
      usesDefaultNamespace: false,
    };
    setLeft(nextLeft);
    setRight(nextRight);
    setSourcesCollapsed(true);
    // 跳转带 autoCompare 时照单排比，不套「齐全」谓词：两侧 dataId 为空在跳转语义里是
    // 「跳过去跑智能匹配」（loadBoth 的 needMatch 分支），是有意为之，不是缺参数。
    if (initialParams.autoCompare) setPendingAutoCompare(autoCompareSnapshotOf(nextLeft, nextRight));
    onInitialParamsConsumed?.();
  }, [initialParams, connections, onInitialParamsConsumed]);

  // 轮46 R02：重启恢复。上一轮退出时停在对比页，且 prefs 里那一对两侧 connId/dataId 都齐，
  // 就把这一对自动比出来 —— 这一对现在只有 cs.diffViewPreferences 一个事实源，
  // 不再有一份 cs.ui 镜像来把它盖掉（轮46 探针实测：旧镜像赢下界面后还会被保存 effect 抄回 prefs，
  // 用户真正比过的那一对一次重启就永久丢失）。
  // 不齐就不许比：dataId 为空的 loadBoth 走的是整命名空间扫描的智能匹配，绝不该在启动时替用户按下。
  useEffect(() => {
    if (restoreCheckedRef.current) return;
    restoreCheckedRef.current = true;
    if (!autoCompareOnRestore) return;
    const restored = initialDiffStateRef.current;
    if (!restored) return;
    if (!isCompleteDiffSourcePair(restored.left, restored.right)) return;
    setPendingAutoCompare(autoCompareSnapshotOf(restored.left, restored.right));
  }, [autoCompareOnRestore]);

  const updateLeft = (source: Source) => {
    setLeft(source);
    setSourcesCollapsed(false);
    resetComparisonState();
  };

  const updateRight = (source: Source) => {
    setRight(source);
    setSourcesCollapsed(false);
    resetComparisonState();
  };

  const changeProject = (projectName: string) => {
    const nextConnections = connections.filter((item) => connectionProjectName(item) === projectName);
    const fallback = chooseDefaultConnection(nextConnections);
    setSelectedProject(projectName);
    setSourcesCollapsed(false);
    resetComparisonState();
    if (fallback) {
      const nextSource = emptySource(fallback.id, connections);
      setLeft(nextSource);
      setRight(nextSource);
    }
  };

  const setConnectionDefaultNamespace = (connId: string, namespace: string) => {
    const next = updateConnection(connId, { defaultNamespace: namespace });
    onConnectionsChange?.(next);
    setNotice(t("diff.defaultNamespaceSaved"));
    setError(null);
  };

  const loadOne = async (source: Source, dataId?: string, groupOverride?: string): Promise<Loaded> => {
    const conn = connections.find((item) => item.id === source.connId);
    if (!conn) throw new Error(t("diff.connectionRequired"));
    const id = (dataId ?? source.dataId).trim();
    if (!id) throw new Error(t("diff.dataIdRequired"));
    const group = (groupOverride ?? source.group).trim() || "DEFAULT_GROUP";
    const content = await getConfig(conn, source.tenant, id, group);

    return {
      label: `${connectionLabel(conn, t)} / ${source.tenant || "public"} / ${id}`,
      content,
      format: detectFormat(id, "", content),
    };
  };

  const prepareText = (loaded: Loaded): string => {
    if (mode === "key") return keysDoc(loaded.content, loaded.format);
    if (mode === "lines") return sortedLinesDoc(loaded.content);
    return loaded.content;
  };

  const loadSideSafe = async (source: Source, dataId: string, group: string, sideFailed: boolean): Promise<Loaded> => {
    if (sideFailed) {
      return { label: `(${t("diff.sideUnavailable")})`, content: "", format: "TEXT" as Format };
    }
    return loadOne(source, dataId, group);
  };

  const missingLoaded = (group: string): Loaded => ({
    label: `(${t("diff.missingConfig")} / ${group})`,
    content: "",
    format: "TEXT" as Format,
  });

  const matchPresenceLabel = (presence: MatchPresence): string => {
    if (presence === "left-only") return t("diff.leftOnly");
    if (presence === "right-only") return t("diff.rightOnly");
    return t("diff.presentBoth");
  };

  const needMatch = !left.dataId.trim() || !right.dataId.trim();

  useEffect(() => {
    const unsubscribe = subscribeConfigChanges((change) => {
      if (
        changeTouchesNamespace(change, left.connId, left.tenant) ||
        changeTouchesNamespace(change, right.connId, right.tenant)
      )
        setResultStale(true);
    });
    return unsubscribe;
  }, [left.connId, left.tenant, right.connId, right.tenant]);

  const doMatch = async () => {
    setResultStale(false);
    setMatchLoading(true);
    setError(null);
    setNotice(null);
    setMatchResults(null);
    setMatchScan(0);
    setMatchGaps([]);
    // 请求序号守卫：重复点「匹配」或切换来源后，旧的聚合结果必须作废而不是覆盖新结果
    const myReq = ++matchReqId.current;
    setBatchResults([]);
    setFailedItems([]);
    setMergeSelections({});
    setMergePreviews({});
    resetTuneState();
    setLeftFailed(false);
    setRightFailed(false);

    try {
      const leftConn = connections.find((item) => item.id === left.connId);
      const rightConn = connections.find((item) => item.id === right.connId);
      if (!leftConn || !rightConn) throw new Error(t("diff.connectionRequired"));
      const leftGroup = left.group.trim() || "DEFAULT_GROUP";
      const rightGroup = right.group.trim() || "DEFAULT_GROUP";

      const [leftResult, rightResult] = await Promise.allSettled([
        listAllConfigs(leftConn, left.tenant, "", leftGroup, {
          pageSize: 500,
          isStale: () => myReq !== matchReqId.current,
          onProgress: (loaded) => {
            if (myReq === matchReqId.current) setMatchScan(loaded);
          },
        }),
        listAllConfigs(rightConn, right.tenant, "", rightGroup, {
          pageSize: 500,
          isStale: () => myReq !== matchReqId.current,
          onProgress: (loaded) => {
            if (myReq === matchReqId.current) setMatchScan(loaded);
          },
        }),
      ]);
      if (myReq !== matchReqId.current) return;

      const leftErr = leftResult.status === "rejected" ? errorText(leftResult.reason) : "";
      const rightErr = rightResult.status === "rejected" ? errorText(rightResult.reason) : "";
      const leftOk = leftResult.status === "fulfilled";
      const rightOk = rightResult.status === "fulfilled";

      // 两侧都失败 → 整体报错
      if (!leftOk && !rightOk) {
        setSourcesCollapsed(false);
        setError(`${t("diff.sourceA")}: ${leftErr}  ${t("diff.sourceB")}: ${rightErr}`);
        return;
      }

      // 标记失败侧
      if (!leftOk) setLeftFailed(true);
      if (!rightOk) setRightFailed(true);

      // 单侧失败提示
      if (!leftOk || !rightOk) {
        const failSide = !leftOk ? t("diff.sourceA") : t("diff.sourceB");
        const failMsg = !leftOk ? leftErr : rightErr;
        setNotice(`${failSide} ${t("diff.sideUnavailable")}: ${failMsg}`);
        setSourcesCollapsed(false);
      }

      const leftPage = leftResult.status === "fulfilled" ? leftResult.value : null;
      const rightPage = rightResult.status === "fulfilled" ? rightResult.value : null;

      const leftItems = leftPage?.items ?? [];
      const rightItems = rightPage?.items ?? [];
      const leftMap = new Map(leftItems.map((item) => [item.dataId, item]));
      const rightMap = new Map(rightItems.map((item) => [item.dataId, item]));
      const leftIds = leftPage ? new Set(leftItems.map((item) => item.dataId)) : null;
      const rightIds = rightPage ? new Set(rightItems.map((item) => item.dataId)) : null;

      // 任一侧列表被截断或少页，都可能让「缺失/一致」结论失真，必须显示并允许复制
      const gaps = [
        ...(leftPage ? describeConfigListGaps(leftPage, t).map((gap) => `${t("diff.sourceA")}: ${gap}`) : []),
        ...(rightPage ? describeConfigListGaps(rightPage, t).map((gap) => `${t("diff.sourceB")}: ${gap}`) : []),
      ];
      if (gaps.length) setMatchGaps(gaps);
      const leftId = left.dataId.trim();
      const rightId = right.dataId.trim();
      let matches: MatchResult[];

      const createMatch = (dataId: string): MatchResult => {
        const hasLeft = leftOk ? !!leftIds?.has(dataId) : true;
        const hasRight = rightOk ? !!rightIds?.has(dataId) : true;
        const presence: MatchPresence = hasLeft && hasRight ? "both" : hasLeft ? "left-only" : "right-only";
        return {
          dataId,
          leftGroup: leftMap.get(dataId)?.group ?? leftGroup,
          rightGroup: rightMap.get(dataId)?.group ?? rightGroup,
          presence,
        };
      };

      if (leftId && rightId) {
        matches = [createMatch(leftId)];
      } else if (leftId) {
        matches = leftOk || rightOk ? [createMatch(leftId)] : [];
      } else if (rightId) {
        matches = leftOk || rightOk ? [createMatch(rightId)] : [];
      } else if (leftOk && rightOk) {
        const allIds = Array.from(new Set([...leftIds!, ...rightIds!])).sort(compareText);
        matches = allIds.map(createMatch);
      } else {
        // 单侧可用 → 用可用侧全部配置，另一侧显示为不可用占位。
        const ids = leftOk ? leftIds! : rightIds!;
        matches = [...ids].sort(compareText).map(createMatch);
      }

      if (matches.length === 0) {
        setSourcesCollapsed(false);
        setError(t("diff.noMatchedDataId"));
        return;
      }

      setMatchResults(matches);
      setSelectedIds(new Set(matches.map((item) => item.dataId)));
      setSourcesCollapsed(true);
    } catch (e) {
      // 请求作废：本次匹配已被新的匹配/来源切换取代，静默丢弃
      if (isStaleRequestError(e)) return;
      const message = errorText(e);
      setSourcesCollapsed(false);
      setError(message);
      reportError({
        title: t("diff.matchFailed"),
        source: t("app.diff"),
        message,
        detail: message,
        mergeKey: "diff:match",
        actionLabel: t("diff.retryMatch"),
        onAction: () => doMatch(),
      });
    } finally {
      setMatchLoading(false);
    }
  };

  const loadBoth = async () => {
    setResultStale(false);
    if (needMatch) {
      await doMatch();
      return;
    }

    setLoading(true);
    setError(null);
    setNotice(null);
    const session = createAuditSession("compare");
    auditSessionRef.current = { id: session, startedAt: new Date().toISOString(), kind: "compare", status: "running", events: [] };
    auditSessionEvent(session, {
      kind: "compare_start",
      scope: "compare",
      mode,
      selectedCount: 1,
      direction: "left->right",
      left: sourceSummary(left, connections, "", t),
      right: sourceSummary(right, connections, "", t),
      source: { connId: left.connId, name: sourceLabel(connections.find((item) => item.id === left.connId) ?? ({} as Connection), t), namespace: left.tenant, dataId: left.dataId, group: left.group },
      target: { connId: right.connId, name: sourceLabel(connections.find((item) => item.id === right.connId) ?? ({} as Connection), t), namespace: right.tenant, dataId: right.dataId, group: right.group },
      dataId: left.dataId || right.dataId,
    });
    const [leftResult, rightResult] = await Promise.allSettled([loadOne(left), loadOne(right)]);
    const errors: string[] = [];

    if (leftResult.status === "fulfilled") setLeftLoaded(leftResult.value);
    else {
      setLeftLoaded(null);
      errors.push(`${t("diff.sourceA")}: ${errorText(leftResult.reason)}`);
    }

    if (rightResult.status === "fulfilled") setRightLoaded(rightResult.value);
    else {
      setRightLoaded(null);
      errors.push(`${t("diff.sourceB")}: ${errorText(rightResult.reason)}`);
    }

    const message = errors.join("  ");
    setError(message || null);
    setSourcesCollapsed(!message);
    if (message) {
      auditSessionEvent(session, { kind: "compare_error", result: "failure", error: message });
      endAuditSession(session, "failure", message);
      reportError({
        title: t("diff.compareLoadFailed"),
        source: t("app.diff"),
        message,
        detail: message,
        mergeKey: `diff:load:${left.connId}:${left.tenant}:${left.group}:${left.dataId}:${right.connId}:${right.tenant}:${right.group}:${right.dataId}`,
        actionLabel: t("diff.retryCompare"),
        onAction: () => loadBoth(),
      });
    }
    {
      const leftText = leftResult.status === "fulfilled" ? leftResult.value.content : "";
      const rightText = rightResult.status === "fulfilled" ? rightResult.value.content : "";
      const stats = diffLines(leftText, rightText);
      auditSessionEvent(session, {
        kind: "compare_result",
        result: "success",
        identical: stats.added === 0 && stats.removed === 0 && stats.modified === 0,
        additions: stats.added,
        deletions: stats.removed,
        changedKeys: stats.modified,
      });
      endAuditSession(session, "success");
    }
    setLoading(false);
  };
  loadBothRef.current = loadBoth;

  useEffect(() => {
    if (!pendingAutoCompare) return;
    const wantLeft = pendingAutoCompare.left;
    const wantRight = pendingAutoCompare.right;
    const ready =
      left.connId === wantLeft.connId &&
      right.connId === wantRight.connId &&
      left.tenant === wantLeft.tenant &&
      right.tenant === wantRight.tenant &&
      left.group === wantLeft.group &&
      right.group === wantRight.group &&
      left.dataId === wantLeft.dataId &&
      right.dataId === wantRight.dataId;
    if (!ready) return;
    setPendingAutoCompare(null);
    void loadBothRef.current?.();
  }, [left, pendingAutoCompare, right]);

  const loadBatch = async () => {
    setResultStale(false);
    if (!matchResults) return;
    const toCompare = matchResults.filter((item) => selectedIds.has(item.dataId));
    if (toCompare.length === 0) return;
    const session = createAuditSession("compare");
    auditSessionRef.current = { id: session, startedAt: new Date().toISOString(), kind: "compare", status: "running", events: [] };
    auditSessionEvent(session, {
      kind: "compare_start",
      scope: "compare",
      mode,
      selectedCount: toCompare.length,
      direction: "left->right",
      left: sourceSummary(left, connections, "", t),
      right: sourceSummary(right, connections, "", t),
      source: { connId: left.connId, name: sourceLabel(connections.find((item) => item.id === left.connId) ?? ({} as Connection), t), namespace: left.tenant, dataId: "", group: left.group },
      target: { connId: right.connId, name: sourceLabel(connections.find((item) => item.id === right.connId) ?? ({} as Connection), t), namespace: right.tenant, dataId: "", group: right.group },
    });

    setBatchLoading(true);
    setBatchResults([]);
    setFailedItems([]);
    setError(null);
    setNotice(null);
    setBatchOnlyChanges(new Set());
    setMergeSelections({});
    setMergePreviews({});
    resetTuneState();

    const results: BatchResult[] = [];
    const failedItems: { dataId: string; error: string; leftGroup: string; rightGroup: string }[] = [];

    for (let i = 0; i < toCompare.length; i += 5) {
      const chunk = toCompare.slice(i, i + 5);
      const settled = await Promise.allSettled(
        chunk.map(async (item) => {
          const [leftItem, rightItem] = await Promise.all([
            item.presence === "right-only"
              ? Promise.resolve(missingLoaded(item.leftGroup))
              : loadSideSafe(left, item.dataId, item.leftGroup, leftFailed),
            item.presence === "left-only"
              ? Promise.resolve(missingLoaded(item.rightGroup))
              : loadSideSafe(right, item.dataId, item.rightGroup, rightFailed),
          ]);
          const hasLeftContent = !leftFailed && item.presence !== "right-only";
          const hasRightContent = !rightFailed && item.presence !== "left-only";
          return {
            dataId: item.dataId,
            leftLabel: leftItem.label,
            rightLabel: rightItem.label,
            leftText: hasLeftContent ? prepareText(leftItem) : "",
            rightText: hasRightContent ? prepareText(rightItem) : "",
            format: (mode === "key" ? "TEXT" : hasLeftContent && leftItem.format !== "TEXT" ? leftItem.format : rightItem.format) as Format,
            presence: item.presence,
          };
        })
      );

      for (let j = 0; j < settled.length; j++) {
        const item = settled[j];
        if (item.status === "fulfilled") {
          results.push(item.value);
        } else {
          failedItems.push({
            dataId: chunk[j].dataId,
            error: errorText(item.reason),
            leftGroup: chunk[j].leftGroup,
            rightGroup: chunk[j].rightGroup,
          });
        }
      }
    }

    const total = toCompare.length;
    const successCount = results.length;
    const failCount = failedItems.length;

    const detailLines = [t("diff.batchCompareDetailSummary", { successCount, total, failCount })];
    if (failedItems.length > 0) {
      detailLines.push(t("diff.batchFailureList"));
      for (const f of failedItems) detailLines.push(`  - ${f.dataId}: ${f.error}`);
    }
    const detail = detailLines.join("\n");

    let level: "success" | "warning" | "error";
    let title: string;
    let message: string;

    if (failCount === 0) {
      level = "success";
      title = t("diff.batchCompareAllSuccessTitle", { successCount, total });
      message = t("diff.batchAllSuccessMessage", { count: successCount });
    } else if (successCount === 0) {
      level = "error";
      title = t("diff.batchCompareAllFailedTitle", { failCount, total });
      message = t("diff.batchAllFailedMessage", { count: failCount, dataIds: failedItems.map((f) => f.dataId).join(", ") });
      setError(t("diff.batchAllFailedInline"));
    } else {
      level = "warning";
      title = t("diff.batchComparePartialTitle", { successCount, total, failCount });
      message = t("diff.batchPartialFailedMessage", { count: failCount, dataIds: failedItems.map((f) => f.dataId).join(", ") });
    }

    reportMessage({
      level,
      title,
      source: t("app.diff"),
      message,
      detail,
      mergeKey: `diff:batch:summary:${Date.now()}`,
      actionLabel: t("common.retry"),
      onAction: () => loadBatch(),
    });

    let totalAdded = 0;
    let totalRemoved = 0;
    let totalModified = 0;
    let identicalCount = 0;
    for (const item of results) {
      const stats = batchResultStats(item.leftText, item.rightText);
      totalAdded += stats.added;
      totalRemoved += stats.removed;
      totalModified += stats.modified;
      if (item.presence === "both" && stats.added === 0 && stats.removed === 0 && stats.modified === 0) identicalCount += 1;
      auditSessionEvent(session, {
        kind: "compare_result",
        result: "success",
        dataId: item.dataId,
        group: left.group,
        identical: item.presence !== "both" ? undefined : stats.added === 0 && stats.removed === 0 && stats.modified === 0,
        additions: stats.added,
        deletions: stats.removed,
        changedKeys: stats.modified,
      });
    }
    for (const item of failedItems) {
      auditSessionEvent(session, { kind: "compare_error", result: "failure", dataId: item.dataId, error: item.error });
    }
    auditSessionEvent(session, {
      kind: "compare_result",
      result: failCount === total ? "failure" : "success",
      summary: {
        total,
        create: identicalCount,
        overwrite: results.length - identicalCount,
        delete: 0,
        skip: 0,
        parseError: 0,
        blocked: 0,
      },
      additions: totalAdded,
      deletions: totalRemoved,
      changedKeys: totalModified,
    });
    endAuditSession(session, failCount === total ? "failure" : "success", failCount > 0 ? failedItems.map((f) => `${f.dataId}: ${f.error}`).join("; ") : undefined);

    setBatchResults(results);
    // 换了一批正文，旧的命中词与「只看命中项」就不再描述眼前的东西了：
    // 留着会让新列表看起来「少了几项」，而用户要找的那句话可能压根不在这一批里。
    clearContentSearch();
    setFailedItems(failedItems);
    if (failedItems.length > 0) {
      setNotice(t("diff.batchFailedNotice", { count: failedItems.length }));
    }
    setSourcesCollapsed(results.length > 0);
    setBatchLoading(false);
  };

  const toggleSelect = (dataId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(dataId)) next.delete(dataId);
      else next.add(dataId);
      return next;
    });
  };

  const toggleAll = () => {
    if (!matchResults) return;
    setSelectedIds((prev) => (prev.size === matchResults.length ? new Set() : new Set(matchResults.map((item) => item.dataId))));
  };

  const showingBatchDiff = batchResults.length > 0;
  const batchResultStatsMap = useMemo(
    () =>
      Object.fromEntries(
        batchResults.map((item) => {
          const preview = mergePreviewForItem(item, mergePreviews);
          return [item.dataId, batchResultStats(preview.leftText, preview.rightText)];
        })
      ),
    [batchResults, mergePreviews]
  );
  const selectedBatchItem =
    (selectedBatchDataId ? batchResults.find((item) => item.dataId === selectedBatchDataId) : null) ?? batchResults[0] ?? null;
  const batchAllOnlyChanges = batchResults.length > 0 && batchResults.every((item) => batchOnlyChanges.has(item.dataId));
  const toggleBatchOnlyChanges = (checked: boolean) => {
    setBatchOnlyChanges(checked ? new Set(batchResults.map((item) => item.dataId)) : new Set());
  };
  const toggleItemOnlyChanges = (dataId: string, checked: boolean) => {
    setBatchOnlyChanges((prev) => {
      const next = new Set(prev);
      if (checked) next.add(dataId);
      else next.delete(dataId);
      return next;
    });
  };

  const setMergeSelection = (dataId: string, rowIndex: number, direction: MergeSelectionDirection, rowIndexes?: number[]) => {
    const item = batchResults.find((result) => result.dataId === dataId);
    if (!item) return;
    const targetRows = rowIndexes && rowIndexes.length > 0 ? rowIndexes : [rowIndex];
    const keys = targetRows.map((index) => mergeSelectionKey(dataId, index));

    if (!canMaterializeMerge(item.presence, direction)) return;
    setMergePreviews((current) => {
      const currentPreview = mergePreviewForItem(item, current);
      const selectedRows = new Set(targetRows);
      const nextPreview: MergePreviewText =
        direction === "left-to-right"
          ? {
              ...currentPreview,
              rightText: materializeMergeText(currentPreview.leftText, currentPreview.rightText, direction, selectedRows),
            }
          : {
              ...currentPreview,
              leftText: materializeMergeText(currentPreview.leftText, currentPreview.rightText, direction, selectedRows),
            };
      if (nextPreview.leftText === currentPreview.leftText && nextPreview.rightText === currentPreview.rightText) return current;
      return { ...current, [dataId]: nextPreview };
    });

    setMergeSelections((current) => {
      const next = { ...current };
      for (const key of keys) next[key] = direction;
      return next;
    });
  };

  const mergeRightCount = batchResults.filter((item) =>
    mergePreviewChanged(item, mergePreviewForItem(item, mergePreviews), "left-to-right")
  ).length;
  const hasMergePreviewDraft = mergeRightCount > 0;

  const returnToMatchList = () => {
    setBatchResults([]);
    setSelectedBatchDataId(null);
    clearContentSearch();
    setFailedItems([]);
    setBatchOnlyChanges(new Set());
    setMergeSelections({});
    setMergePreviews({});
    resetTuneState();
  };

  const retryCurrentCompare = () => {
    if (leftFailed || rightFailed) {
      setLeftFailed(false);
      setRightFailed(false);
    }
    if (matchResults) void loadBatch();
    else void loadBoth();
  };

  const sameNameMatchIds = matchResults?.filter((item) => item.presence === "both").map((item) => item.dataId) ?? [];
  const hasFilePresenceDiff = matchResults?.some((item) => item.presence !== "both") ?? false;
  const selectSameNameMatches = () => {
    setSelectedIds(new Set(sameNameMatchIds));
  };

  const ready = leftLoaded && rightLoaded;
  const leftText = ready ? prepareText(leftLoaded) : "";
  const rightText = ready ? prepareText(rightLoaded) : "";
  const diffFormat = mode === "key" ? "TEXT" : leftLoaded?.format !== "TEXT" ? leftLoaded?.format : rightLoaded?.format;
  /**
   * 单配置模式「右侧现在到底是什么内容」的唯一口径（轮60 R1）：
   * 结果面板、重复键警告、进入计划三处都读这一份，用户才看得见自己写的东西真的落进了结果。
   */
  const effectiveSingleRightText = singleTune ? singleTune.content : rightText;
  /** diffFormat 在类型上可空（两侧都没加载时），微调的校验与格式化需要一个确定的格式。 */
  const singleTuneFormat: Format = diffFormat ?? "TEXT";
  const singleWarnings = useMemo(() => {
    if (!ready || diffFormat !== "YAML") return [] as string[];
    const warnings: string[] = [];
    const leftWarn = buildDuplicateKeyWarning(t, "diff.duplicateSideLeft", leftLoaded.label, leftText);
    const rightWarn = buildDuplicateKeyWarning(t, "diff.duplicateSideRight", rightLoaded.label, effectiveSingleRightText);
    if (leftWarn) warnings.push(leftWarn);
    if (rightWarn) warnings.push(rightWarn);
    return warnings;
  }, [ready, diffFormat, leftLoaded, rightLoaded, leftText, effectiveSingleRightText, t]);
  const leftConn = connections.find((item) => item.id === left.connId);
  const rightConn = connections.find((item) => item.id === right.connId);
  const currentWorkflowStep: WorkflowStepId =
    loading || matchLoading || batchLoading
      ? "compare"
      : batchResults.length > 0 || Boolean(ready)
        ? "plan"
        : matchResults
          ? "compare"
          : "choose";

  // ── 人工微调右侧目标内容（轮60 B线）──────────────────────────────────────
  //
  // 只有一条写入通道：微调结果最终仍变成计划项的 sourceValueOverride（与挑块合并同一条），
  // 第三步不直接写服务端，也不另开一套校验/持久化/审计。非法文本存不下来——保存是唯一出口，
  // 校验不过就留在编辑态报行内错误（与第四步 commitEdit 同一不变式，R5）。

  const tuneErrorsFor = (content: string, format: Format): string[] => {
    // validateConfig 对空串放行（浏览态允许清空），这里必须自己拦：空白正文进计划等于要删空目标。
    if (!content.trim()) return [t("diff.manualTuneBlank")];
    return validateConfig(content, format);
  };

  /**
   * 微调动作进审计会话：只记定位、长度、行数与被清掉的挑块标记数，**不记正文**。
   * 正文在随后的变更计划（apply_session_start）里已经有一份完整现场，重复抄进对比会话
   * 只会让含凭据的配置在 jsonl 里多落一次。
   */
  const auditTuneEvent = (fields: {
    action: "tune" | "reset";
    scope: "single" | "batch";
    dataId: string;
    group: string;
    content: string;
    clearedMarks: number;
  }) => {
    const session = auditSessionRef.current;
    if (!session) return;
    auditSessionEvent(session.id, {
      kind: "diff_manual_tune",
      scope: fields.scope,
      step: "plan",
      dataId: fields.dataId,
      group: fields.group,
      payload: JSON.stringify({
        action: fields.action,
        scope: fields.scope,
        dataId: fields.dataId,
        group: fields.group,
        charCount: fields.content.length,
        lineCount: fields.content.length === 0 ? 0 : fields.content.split(/\r?\n/).length,
        clearedMergeMarks: fields.clearedMarks,
      }),
    });
  };

  const openTuneEditor = (key: string, seed: string) => {
    setTuneDrafts((current) => (current[key] ? current : { ...current, [key]: { content: seed, errors: [] } }));
    setTuneNotice(null);
    setTuneEditingKey(key);
  };

  const writeTuneDraft = (key: string, next: TargetTuneDraft) => {
    setTuneDrafts((current) => ({ ...current, [key]: next }));
  };

  const dropTuneDraft = (key: string) => {
    setTuneDrafts((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  /** 抽屉里的「取消」只是收起编辑态：草稿留在宿主，已保存的微调结果不受影响。 */
  const closeTuneEditor = () => {
    setTuneEditingKey(null);
    setTuneNotice(null);
  };

  /** 批量：切换选中文件时抽屉跟着收起（草稿不丢，切回来接着写）。 */
  const selectedBatchTuneKey = selectedBatchItem ? batchTuneKey(selectedBatchItem.dataId) : null;
  const batchTuneOpen =
    Boolean(selectedBatchItem) && tuneEditingKey === selectedBatchTuneKey && selectedBatchItem.presence !== "right-only";
  const singleTuneOpen = tuneEditingKey === SINGLE_TUNE_KEY;

  const handleBatchTune = (item: BatchResult) => {
    const key = batchTuneKey(item.dataId);
    if (tuneEditingKey === key) {
      closeTuneEditor();
      return;
    }
    openTuneEditor(key, mergePreviewForItem(item, mergePreviews).rightText);
  };

  const commitBatchTune = (item: BatchResult) => {
    const key = batchTuneKey(item.dataId);
    const draft = tuneDrafts[key];
    if (!draft) return;
    const errors = tuneErrorsFor(draft.content, item.format);
    if (errors.length > 0) {
      writeTuneDraft(key, { ...draft, errors });
      return;
    }
    const prefix = `${item.dataId}::`;
    const clearedMarks = Object.keys(mergeSelections).filter((rowKey) => rowKey.startsWith(prefix)).length;
    setMergePreviews((current) => ({
      ...current,
      [item.dataId]: { ...mergePreviewForItem(item, current), rightText: draft.content },
    }));
    // R6：正文一改，行级挑块标记的行号就指向别处。留着会让用户以为「这几行还是从左边挑的」，
    // 而下一步是真要写进生产的——清空 + 一句解释，比默默错位安全。
    if (clearedMarks > 0) {
      setMergeSelections((current) => {
        const next: Record<string, MergeSelectionDirection> = {};
        for (const [rowKey, direction] of Object.entries(current)) {
          if (!rowKey.startsWith(prefix)) next[rowKey] = direction;
        }
        return next;
      });
    }
    setTunedDataIds((current) => (current.has(item.dataId) ? current : new Set(current).add(item.dataId)));
    writeTuneDraft(key, { content: draft.content, errors: [] });
    // 保存后**留在**编辑态：抽屉收起的话，R6 那句「行级挑选标记已清空」的解释会跟着一起消失，
    // 而用户下一次点箭头时恰恰需要它。收起交给「完成微调」/Esc。
    setTuneNotice(clearedMarks > 0 ? t("diff.manualTuneMarksCleared") : null);
    const matchGroup =
      (matchResults ?? []).find((match) => match.dataId === item.dataId)?.rightGroup ?? right.group ?? "DEFAULT_GROUP";
    auditTuneEvent({ action: "tune", scope: "batch", dataId: item.dataId, group: matchGroup, content: draft.content, clearedMarks });
  };

  /** 这一项当前的右侧最终正文是否已偏离服务端原文（含没保存的手写字迹）。 */
  const batchTuneIsDirty = (item: BatchResult) => {
    if (mergePreviewForItem(item, mergePreviews).rightText !== item.rightText) return true;
    const draft = tuneDrafts[batchTuneKey(item.dataId)];
    return Boolean(draft && draft.content !== item.rightText);
  };

  /** 真正执行丢弃：预览整条删掉，落回 item 自己的右侧正文。 */
  const discardBatchTune = (item: BatchResult) => {
    const key = batchTuneKey(item.dataId);
    const matchGroup =
      (matchResults ?? []).find((match) => match.dataId === item.dataId)?.rightGroup ?? right.group ?? "DEFAULT_GROUP";
    setMergePreviews((current) => {
      if (!current[item.dataId]) return current;
      const next = { ...current };
      delete next[item.dataId];
      return next;
    });
    setTunedDataIds((current) => {
      if (!current.has(item.dataId)) return current;
      const next = new Set(current);
      next.delete(item.dataId);
      return next;
    });
    dropTuneDraft(key);
    setTuneNotice(null);
    setTuneEditingKey(null);
    auditTuneEvent({ action: "reset", scope: "batch", dataId: item.dataId, group: matchGroup, content: item.rightText, clearedMarks: 0 });
  };

  /** R7：还原 = 撤掉微调并回到「右侧原内容」。有字迹先问，没改过直接收。 */
  const resetBatchTune = (item: BatchResult) => {
    if (batchTuneIsDirty(item)) {
      setTuneDiscardPending({ scope: "batch", dataId: item.dataId });
      return;
    }
    discardBatchTune(item);
  };

  const toggleSingleTune = () => {
    if (singleTuneOpen) {
      closeTuneEditor();
      return;
    }
    openTuneEditor(SINGLE_TUNE_KEY, singleTune ? singleTune.content : rightText);
  };

  const commitSingleTune = () => {
    const draft = tuneDrafts[SINGLE_TUNE_KEY];
    if (!draft) return;
    const errors = tuneErrorsFor(draft.content, singleTuneFormat);
    if (errors.length > 0) {
      writeTuneDraft(SINGLE_TUNE_KEY, { ...draft, errors });
      return;
    }
    setSingleTune({ content: draft.content, errors: [] });
    writeTuneDraft(SINGLE_TUNE_KEY, { content: draft.content, errors: [] });
    // 同批量：保存不收抽屉，收起由「完成微调」/Esc 负责（见 commitBatchTune 的注释）。
    setTuneNotice(null);
    auditTuneEvent({
      action: "tune",
      scope: "single",
      dataId: right.dataId.trim(),
      group: right.group || "DEFAULT_GROUP",
      content: draft.content,
      clearedMarks: 0,
    });
  };

  const discardSingleTune = () => {
    setSingleTune(null);
    dropTuneDraft(SINGLE_TUNE_KEY);
    setTuneNotice(null);
    setTuneEditingKey(null);
    auditTuneEvent({
      action: "reset",
      scope: "single",
      dataId: right.dataId.trim(),
      group: right.group || "DEFAULT_GROUP",
      content: rightText,
      clearedMarks: 0,
    });
  };

  /** 同批量：手写的正文一旦被还原就找不回来，先经确认。 */
  const resetSingleTune = () => {
    const draft = tuneDrafts[SINGLE_TUNE_KEY];
    const dirty = effectiveSingleRightText !== rightText || Boolean(draft && draft.content !== rightText);
    if (dirty) {
      setTuneDiscardPending({ scope: "single", dataId: right.dataId.trim() });
      return;
    }
    discardSingleTune();
  };

  const startSingleApply = () => {
    if (!ready || !onStartApply) return;
    // R5：结果过期还带着手写正文进计划 = 拿旧基线上的字迹去写生产。纯引用路径不受影响
    // （计划生成时按 ref 现读并自判新鲜度），被锁的只有物化出来的这一份。
    if (resultStale && singleTune) return;
    const source = applyEntryEndpointFromSource(left, connections, t);
    const target = applyEntryEndpointFromSource(right, connections, t);
    const sourceRef = applyEntryItemFromSource(left, connections, left.dataId.trim(), left.group);
    const targetRef = applyEntryItemFromSource(right, connections, right.dataId.trim(), right.group);
    if (!source || !target || !sourceRef || !targetRef) return;
    const item: ApplyEntryItem = {
      ...targetRef,
      sourceRef,
      targetRef,
    };
    if (singleTune) {
      // 与批量合并同一条物化通道（R3）；sourceFingerprint 仍由 applyPlanDraft 用实时读到的
      // 原始来源计算，人工文本不参与新鲜度基线，所以这不是绕过守卫。
      const normalized = normalizeConfig(singleTune.content, singleTuneFormat);
      item.sourceValueOverride = {
        exists: true,
        value: singleTune.content,
        valueType: "text",
        format: diffFormat,
        parseStatus: normalized.parseStatus,
        ...(normalized.parseError ? { parseError: normalized.parseError } : {}),
        content: singleTune.content,
      };
      item.manualTuned = true;
    }

    onStartApply({
      sourceType: "diff",
      scope: "config",
      source,
      target,
      items: [item],
      rangeSummary: applyEntryRiskSummary([item]),
      origin: {
        mode: "diff",
        returnMode: "diff",
      },
    });
  };

  const startBatchApply = () => {
    if (!onStartApply || batchResults.length === 0) return;
    const source = applyEntryEndpointFromSource(left, connections, t);
    const target = applyEntryEndpointFromSource(right, connections, t);
    if (!source || !target) return;

    const matchByDataId = new Map((matchResults ?? []).map((item) => [item.dataId, item]));
    const items = batchResults
      .map((item): ApplyEntryItem | null => {
        const match = matchByDataId.get(item.dataId);
        const sourceRef = applyEntryItemFromSource(left, connections, item.dataId, match?.leftGroup ?? left.group);
        const targetRef = applyEntryItemFromSource(right, connections, item.dataId, match?.rightGroup ?? right.group);
        if (!sourceRef || !targetRef) return null;
        return {
          ...targetRef,
          sourceRef,
          targetRef,
        };
      })
      .filter((item): item is ApplyEntryItem => item !== null);
    if (items.length === 0) return;

    onStartApply({
      sourceType: "diff",
      scope: "batch",
      source,
      target,
      items,
      rangeSummary: applyEntryRiskSummary(items, failedItems.length),
      origin: {
        mode: "diff",
        returnMode: "diff",
      },
    });
  };

  const startMergeDraftApply = () => {
    if (!onStartApply || batchResults.length === 0) return;
    const source = applyEntryEndpointFromSource(left, connections, t);
    const target = applyEntryEndpointFromSource(right, connections, t);
    if (!source || !target) return;

    const matchByDataId = new Map((matchResults ?? []).map((item) => [item.dataId, item]));
    let skippedCount = failedItems.length;
    const items = batchResults
      .map((item): ApplyEntryItem | null => {
        const preview = mergePreviewForItem(item, mergePreviews);
        if (!mergePreviewChanged(item, preview, "left-to-right")) return null;
        if (!canMaterializeMerge(item.presence, "left-to-right")) {
          skippedCount += 1;
          return null;
        }

        const mergedText = preview.rightText;
        const currentTargetText = item.rightText;
        if (mergedText === currentTargetText) {
          skippedCount += 1;
          return null;
        }

        const match = matchByDataId.get(item.dataId);
        const sourceGroup = match?.leftGroup ?? left.group;
        const targetGroup = match?.rightGroup ?? right.group;
        const sourceRef = applyEntryItemFromSource(left, connections, item.dataId, sourceGroup);
        const targetRef = applyEntryItemFromSource(right, connections, item.dataId, targetGroup);
        if (!sourceRef || !targetRef) return null;

        const normalized = normalizeConfig(mergedText, item.format);
        return {
          ...targetRef,
          sourceRef,
          targetRef,
          // 手写与挑块合并都带 override，计划里只能靠这颗标记分得开（R4）。
          ...(tunedDataIds.has(item.dataId) ? { manualTuned: true } : {}),
          sourceValueOverride: {
            exists: true,
            value: mergedText,
            valueType: "text",
            format: item.format,
            parseStatus: normalized.parseStatus,
            ...(normalized.parseError ? { parseError: normalized.parseError } : {}),
            content: mergedText,
          },
        };
      })
      .filter((item): item is ApplyEntryItem => item !== null);

    if (items.length === 0) {
      reportMessage({
        level: "warning",
        title: t("diff.mergePlanNoChanges"),
        source: t("app.diff"),
        message: t("diff.mergePlanNoChanges"),
        mergeKey: "diff:merge-plan:no-changes",
      });
      return;
    }

    onStartApply({
      sourceType: "diff",
      scope: "batch",
      source,
      target,
      items,
      rangeSummary: applyEntryRiskSummary(items, skippedCount),
      origin: {
        mode: "diff",
        returnMode: "diff",
      },
    });
  };

  // 结果已过期 + 还有未清空的合并草稿：草稿里挑的是「过期基线」上的内容，
  // 直接带进计划等于拿旧值去写，而计划页看到的是自己生成的 diff，用户没有第二次机会发现。
  // 纯引用路径不受影响——计划生成时按 ref 现读并做新鲜度校验，过期了会自己报 stale。
  // 所以这里只锁草稿这一条，并说清楚「重新对比」是唯一的出路（R55-A7）。
  const enterPlanBlockedByStaleMerge = resultStale && (hasMergePreviewDraft || Boolean(singleTune));
  const singleApplyBlockedByStaleTune = resultStale && Boolean(singleTune);

  const startApplyFromCurrentDiff = () => {
    if (enterPlanBlockedByStaleMerge) return;
    if (hasMergePreviewDraft) {
      startMergeDraftApply();
      return;
    }
    startBatchApply();
  };

  // ── 工作流 stepper 导航（仅回退：任意回退保留状态；前进走页面内操作按钮） ──
  // 回退 = 滚动到目标区域 + 目标区域高亮闪烁（已停留在目标区域时，滚动本身无可见变化）
  const cancelArrivalFlashRef = useRef<(() => void) | null>(null);
  const focusWorkflowStep = useCallback((step: WorkflowStepId) => {
    const target = step === "choose" ? sourcesRef.current : resultsRef.current;
    if (step === "choose") setSourcesCollapsed(false);
    if (!target) return;
    // 滚动 + 闪烁的算式只在 lib/arriveFlash 里有一份（轮74 D2）：
    // 页内回退不抢焦点，所以不传 focus —— 抢焦点会把用户正在填的表单光标带走。
    cancelArrivalFlashRef.current?.();
    cancelArrivalFlashRef.current = revealArrival(target);
  }, []);
  useEffect(
    () => () => {
      cancelArrivalFlashRef.current?.();
      cancelArrivalFlashRef.current = null;
    },
    []
  );
  useEffect(() => {
    // `!active` 这支是常驻挂载换来的新风险：计划页「返回」若把 focusStep 递给看不见的对比页，
    // focusWorkflowStep 就在隐藏子树里找元素抢焦点。App 侧已经只在 diff 是回程目标时才递，
    // 这里再兜一道，两个闸门任一个被改回都不会漏。
    if (!focusStep || !active) return;
    focusWorkflowStep(focusStep);
    onFocusStepConsumed?.();
  }, [active, focusStep, focusWorkflowStep, onFocusStepConsumed]);
  if (connections.length === 0) {
    return <div className="pad-msg big">{t("diff.noConnection")}</div>;
  }

  return (
    <div className="diff-view">
      {/* 页面头部 */}
      <div className="page-header diff-header">
        <div>
          <h3>{t("app.diff")}</h3>
          <div className="page-subtitle">{t("diff.pageSubtitle")}</div>
        </div>
        <DiffWorkflowCard
          currentStep={currentWorkflowStep}
          onStepClick={focusWorkflowStep}
        />
        <div className="page-actions">
          <label className="diff-project-select">
            <span>{t("connection.project")}</span>
            <Select className="wide" value={activeProject} options={projectOptions} onChange={changeProject} />
          </label>
        </div>
      </div>

      <div className="diff-workspace" ref={workspaceRef}>
        <div className="diff-main-column">
          <div className={`diff-source-panel${sourcesCollapsed ? " collapsed" : ""}`}>
            <div className="diff-source-summary" aria-hidden={!sourcesCollapsed}>
              <div className="diff-source-summary-card">
                <span className="diff-source-summary-title">{t("diff.sourceA")}</span>
                {leftConn?.sourceType === "local-snapshot" ? (
                  <span className="env-badge env-local" title={t("connection.sourceTypeSnapshot")}>
                    {t("connection.sourceTypeSnapshot")}
                  </span>
                ) : leftConn ? (
                  <EnvironmentBadge name={connectionEnvironmentName(leftConn)} />
                ) : null}
                <span className="diff-source-summary-text" title={sourceSummary(left, connections, t("diff.autoMatch"), t)}>
                  {sourceSummary(left, connections, t("diff.autoMatch"), t)}
                </span>
              </div>
              <div className="diff-source-summary-card">
                <span className="diff-source-summary-title">{t("diff.sourceB")}</span>
                {rightConn?.sourceType === "local-snapshot" ? (
                  <span className="env-badge env-local" title={t("connection.sourceTypeSnapshot")}>
                    {t("connection.sourceTypeSnapshot")}
                  </span>
                ) : rightConn ? (
                  <EnvironmentBadge name={connectionEnvironmentName(rightConn)} />
                ) : null}
                <span className="diff-source-summary-text" title={sourceSummary(right, connections, t("diff.autoMatch"), t)}>
                  {sourceSummary(right, connections, t("diff.autoMatch"), t)}
                </span>
              </div>
            </div>
            <div className="diff-sources" ref={sourcesRef} aria-hidden={sourcesCollapsed}>
              <SourcePicker
                title={t("diff.sourceA")}
                active={active}
                connections={connections}
                projectConnections={projectConnections}
                source={left}
                onChange={updateLeft}
                onLoadError={() => setSourcesCollapsed(false)}
                onSetDefaultNamespace={onConnectionsChange ? setConnectionDefaultNamespace : undefined}
                sortConnections={settings.compare.sortConnections}
                sortNamespaces={settings.compare.sortNamespaces}
              />
              <button
                type="button"
                className="diff-source-direction"
                aria-label={t("diff.sourceDirection")}
                title={t("diff.startApply")}
                onClick={() => {
                  if (onStartApply && ready) {
                    try {
                      startSingleApply();
                    } catch (e) {
                    }
                  } else {
                    toast(t("diff.startApplyNeedsLoad"), "info");
                  }
                }}
              >
                <span className="diff-source-direction-arrow" aria-hidden="true">
                  {"\u2192"}
                </span>
              </button>
              <SourcePicker
                title={t("diff.sourceB")}
                active={active}
                connections={connections}
                projectConnections={projectConnections}
                source={right}
                onChange={updateRight}
                onLoadError={() => setSourcesCollapsed(false)}
                onSetDefaultNamespace={onConnectionsChange ? setConnectionDefaultNamespace : undefined}
                sortConnections={settings.compare.sortConnections}
                sortNamespaces={settings.compare.sortNamespaces}
              />
            </div>
            <button
              type="button"
              className="diff-source-toggle-edge"
              onClick={() => setSourcesCollapsed((value) => !value)}
              aria-label={sourcesCollapsed ? t("diff.expandSources") : t("diff.collapseSources")}
              title={sourcesCollapsed ? t("diff.expandSources") : t("diff.collapseSources")}
              aria-expanded={!sourcesCollapsed}
            >
              <span aria-hidden="true">{sourcesCollapsed ? "\u2304" : "\u2303"}</span>
            </button>
          </div>

          <div className={`diff-loadbar${showingBatchDiff ? " result-actions" : ""}`}>
            {showingBatchDiff ? (
              <>
                <div className="merge-workbench-summary" aria-live="polite">
                  <div className="merge-workbench-copy">
                    <span className="merge-workbench-title">{t("diff.mergeWorkbenchTitle")}</span>
                    <span className="merge-workbench-hint">{t("diff.mergeWorkbenchHint")}</span>
                  </div>
                  <div className="merge-scope-toggle" role="group" aria-label={t("diff.mergeScopeLabel")}>
                    <span className="merge-scope-label">{t("diff.mergeScopeLabel")}</span>
                    <button
                      type="button"
                      className={`merge-scope-btn${mergeSelectionScope === "row" ? " active" : ""}`}
                      onClick={() => setMergeSelectionScope("row")}
                      aria-pressed={mergeSelectionScope === "row"}
                    >
                      {t("diff.mergeScopeRow")}
                    </button>
                    <button
                      type="button"
                      className={`merge-scope-btn${mergeSelectionScope === "block" ? " active" : ""}`}
                      onClick={() => setMergeSelectionScope("block")}
                      aria-pressed={mergeSelectionScope === "block"}
                    >
                      {t("diff.mergeScopeBlock")}
                    </button>
                  </div>
                  <span className="merge-draft-summary">
                    {hasMergePreviewDraft ? t("diff.mergeDraftSummary", { right: mergeRightCount }) : t("diff.mergeDraftEmpty")}
                  </span>
                </div>
                <span className="fmt-spacer" />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm result-action result-action-back"
                  onClick={returnToMatchList}
                  disabled={batchLoading}
                >
                  {t("diff.backToMatchList")}
                </button>
                <span className="batch-diff-count result-action-count">{t("diff.batchGenerated", { count: batchResults.length })}</span>
                <label className="diff-toggle result-action-filter">
                  <input type="checkbox" checked={batchAllOnlyChanges} onChange={(e) => toggleBatchOnlyChanges(e.target.checked)} />
                  {t("diff.batchOnlyChanges")}
                </label>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm result-action result-action-clear"
                  onClick={() => {
                    setMergeSelections({});
                    setMergePreviews({});
                    resetBatchTuneDrafts();
                  }}
                  disabled={!hasMergePreviewDraft}
                >
                  {t("diff.mergeClearDraft")}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm result-action result-action-export"
                  title={t("diff.exportDiff")}
                  onClick={() => {
                    // 分类口径与文件列表的逐文件统计一致：单侧文件按新增/删除记，
                    // 三项统计全 0 的按未变更记（R55-D4）。以前三元两个分支都写死
                    // "modified"，导出的报告里永远「全部已变更」，跟页面显示的 +0/−0/~0 打架。
                    const diffs: DiffItem[] = batchResults.map((item) => {
                      const stats = batchResultStats(item.leftText, item.rightText);
                      const identical = stats.added === 0 && stats.removed === 0 && stats.modified === 0;
                      const diffType: DiffItem["diffType"] =
                        item.presence === "left-only" ? "added" : item.presence === "right-only" ? "deleted" : identical ? "unchanged" : "modified";
                      return {
                        dataId: item.dataId,
                        group: item.leftLabel.split("/")[1] || "DEFAULT_GROUP",
                        namespace: left.tenant || "",
                        leftValue: item.leftText,
                        rightValue: item.rightText,
                        diffType,
                      };
                    });
                    exportDiff(diffs, "json");
                  }}
                >
                  {t("diff.exportDiff")}
                </button>
                {onStartApply && (
                  <div className="merge-plan-actions">
                    {/* disabled 收不到 pointer 事件，原因挂在包裹的 .btn-guard 上（与执行确认区同一写法）；
                        读屏不靠悬停，紧跟一条 field-hint 把话说完。 */}
                    <span className="btn-guard" title={enterPlanBlockedByStaleMerge ? t("diff.enterPlanBlockedStaleMerge") : undefined}>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm result-action result-action-plan"
                        onClick={startApplyFromCurrentDiff}
                        disabled={enterPlanBlockedByStaleMerge}
                        aria-disabled={enterPlanBlockedByStaleMerge}
                      >
                        {t("diff.enterBatchApply", { count: hasMergePreviewDraft ? mergeRightCount : batchResults.length })}
                      </button>
                    </span>
                    {enterPlanBlockedByStaleMerge && (
                      <span className="merge-plan-blocker">{t("diff.enterPlanBlockedStaleMerge")}</span>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <span className="fmt-label">{t("diff.compareMode")}</span>
                <Select
                  value={mode}
                  options={[
                    { value: "text", label: t("diff.modeText") },
                    { value: "lines", label: t("diff.modeLines") },
                    { value: "key", label: t("diff.modeKey") },
                  ]}
                  onChange={(value) => setMode(value as DiffMode)}
                />
                {matchResults ? (
                  <button className="btn btn-primary" onClick={loadBatch} disabled={batchLoading || selectedIds.size === 0}>
                    {batchLoading ? t("diff.comparing") : t("diff.compareSelected", { count: selectedIds.size })}
                  </button>
                ) : (
                  <button className="btn btn-primary" onClick={loadBoth} disabled={loading || matchLoading}>
                    {loading || matchLoading ? t("common.loading") : t("diff.loadAndCompare")}
                  </button>
                )}
                {!matchResults && ready && onStartApply && (
                  <span className="merge-plan-actions">
                    <button
                      type="button"
                      className={`btn btn-ghost${singleTuneOpen ? " active" : ""}`}
                      aria-pressed={singleTuneOpen}
                      onClick={toggleSingleTune}
                    >
                      {singleTuneOpen ? t("diff.manualTuneEditing") : t("diff.manualTune")}
                    </button>
                    {singleTune && (
                      <span className="tune-badge" title={t("diff.manualTuneBadgeHint")}>
                        {t("diff.manualTuneBadge")}
                      </span>
                    )}
                    {singleApplyBlockedByStaleTune ? (
                      <>
                        <span className="btn-guard" title={t("diff.enterPlanBlockedStaleTune")}>
                          <button className="btn btn-ghost" onClick={startSingleApply} disabled aria-disabled>
                            {t("diff.startApply")}
                          </button>
                        </span>
                        <span className="merge-plan-blocker">{t("diff.enterPlanBlockedStaleTune")}</span>
                      </>
                    ) : (
                      <button className="btn btn-ghost" onClick={startSingleApply}>
                        {t("diff.startApply")}
                      </button>
                    )}
                  </span>
                )}
                {matchLoading && matchScan > 0 && <div className="diff-loadok">{t("diff.matchScanning", { count: matchScan })}</div>}
                {matchGaps.length > 0 && (
                  <div className="diff-warnings" role="status">
                    {matchGaps.map((gap) => (
                      <div className="diff-warning" key={gap}>
                        {gap}
                      </div>
                    ))}
                    <div className="field-error-actions">
                      <CopyButton text={matchGaps.join("\n")} label={t("diff.copyError")} />
                    </div>
                  </div>
                )}
                {notice && (
                  <div className={`diff-loadok${leftFailed || rightFailed ? " warn" : ""}`}>
                    <span>{notice}</span>
                    {(leftFailed || rightFailed) && <CopyButton text={notice} label={t("diff.copyError")} />}
                  </div>
                )}
                {error && (
                  <div className="diff-loaderr">
                    <span title={error}>{error}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={retryCurrentCompare}
                      disabled={loading || matchLoading || batchLoading}
                    >
                      {t("diff.retryCompare")}
                    </button>
                    <CopyButton text={error} label={t("diff.copyError")} />
                  </div>
                )}
              </>
            )}
          </div>

          <div className={`diff-result${showingBatchDiff ? " diff-result-batch" : ""}`} ref={resultsRef}>
            {resultStale && (leftLoaded || rightLoaded || batchResults.length > 0 || (matchResults?.length ?? 0) > 0) && (
              <div className="diff-warnings diff-result-stale" role="status" aria-live="polite">
                <div className="diff-warning">{t("diff.resultStale")}</div>
                <div className="field-error-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={retryCurrentCompare}
                    disabled={loading || matchLoading || batchLoading}
                  >
                    {t("diff.retryCompare")}
                  </button>
                </div>
              </div>
            )}

            {matchResults && matchResults.length > 0 && batchResults.length === 0 && (
              <div className="match-list">
                <div className="match-list-head">
                  <label className="match-toggle-all">
                    <input type="checkbox" checked={selectedIds.size === matchResults.length} onChange={toggleAll} />
                    {t("diff.selectAll")}
                  </label>
                  <span className="match-count">{t("diff.matchCount", { total: matchResults.length, selected: selectedIds.size })}</span>
                  {hasFilePresenceDiff && (
                    <button type="button" className="btn btn-ghost btn-sm match-same-only" onClick={selectSameNameMatches}>
                      {t("diff.selectSameNameOnly")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => doMatch()}
                    disabled={matchLoading}
                    title={t("diff.refreshMatch")}
                    aria-label={t("diff.refreshMatch")}
                  >
                    ⟳
                  </button>
                </div>
                <div className="match-side-by-side">
                  <div className="match-side-list left">
                    <div className="match-side-title">{t("diff.sourceA")}</div>
                    <div className="match-side-scroll" ref={matchLeftScrollRef}>
                      {matchResults.map((item) => (
                        <label className={`match-side-row match-item ${item.presence}`} key={item.dataId}>
                          <input type="checkbox" checked={selectedIds.has(item.dataId)} onChange={() => toggleSelect(item.dataId)} />
                          <span className={`match-dataid${item.presence === "right-only" ? " missing" : ""}`} title={item.dataId}>
                            {item.presence === "right-only" ? t("diff.missingConfig") : item.dataId}
                          </span>
                          <span className={`match-presence ${item.presence}`}>{matchPresenceLabel(item.presence)}</span>
                          <span className="match-group">{item.leftGroup}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="match-side-list right">
                    <div className="match-side-title">{t("diff.sourceB")}</div>
                    <div className="match-side-scroll" ref={matchRightScrollRef} tabIndex={0} role="region" aria-label={t("diff.sourceB")}>
                      {matchResults.map((item) => (
                        <div className={`match-side-row match-counterpart ${item.presence}`} key={item.dataId}>
                          <span className={`match-dataid${item.presence === "left-only" ? " missing" : ""}`} title={item.dataId}>
                            {item.presence === "left-only" ? t("diff.missingConfig") : item.dataId}
                          </span>
                          <span className={`match-presence ${item.presence}`}>{matchPresenceLabel(item.presence)}</span>
                          <span className="match-group">{item.rightGroup}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {batchResults.length > 0 && (
              <div className="batch-diff">
                {failedItems.length > 0 && (
                  <div className="batch-diff-failures">
                    <div className="batch-diff-failures-head">
                      <span className="batch-diff-failures-count">{t("diff.batchFailureHeader", { count: failedItems.length })}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          const retryItems = matchResults?.filter((m) => failedItems.some((f) => f.dataId === m.dataId)) ?? [];
                          setSelectedIds(new Set(retryItems.map((r) => r.dataId)));
                          void loadBatch();
                        }}
                        disabled={batchLoading}
                      >
                        {t("diff.retryAll")}
                      </button>
                    </div>
                    <div className="batch-diff-failures-list">
                      {failedItems.map((f) => (
                        <div className="batch-diff-failures-item" key={f.dataId}>
                          <span className="batch-diff-failures-dataid">{f.dataId}</span>
                          <span className="batch-diff-failures-error" title={f.error}>
                            {f.error}
                          </span>
                          <CopyButton text={`${f.dataId}: ${f.error}`} label={t("diff.copyError")} />
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                              setSelectedIds(new Set([f.dataId]));
                              void loadBatch();
                            }}
                            disabled={batchLoading}
                          >
                            {t("common.retry")}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className="batch-diff-layout">
                  <aside className="batch-diff-nav" aria-label={t("diff.batchFileList")}>
                    <div className="batch-diff-nav-head">{t("diff.batchFileList")}</div>
                    <div className="batch-diff-search">
                      <input
                        type="text"
                        className="search-input"
                        placeholder={t("diff.contentSearchPlaceholder")}
                        aria-label={t("diff.contentSearchAriaLabel")}
                        ref={contentSearchInputRef}
                        value={contentSearchInput}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        onChange={(event) => onContentSearchChange(event.target.value)}
                        onCompositionStart={onContentSearchCompositionStart}
                        onCompositionEnd={(event) => onContentSearchCompositionEnd(event.currentTarget.value)}
                        onKeyDown={onContentSearchKeyDown}
                      />
                    </div>
                    {isContentSearchActive && (
                      <div className="batch-diff-search-tools">
                        <div className="batch-diff-search-status" {...statusMessageProps("info")}>
                          {diffSearch.matchedItemCount > 0 ? (
                            <span>
                              {t("diff.contentSearchCount", { items: diffSearch.matchedItemCount, matches: diffSearch.listedMatches })}
                            </span>
                          ) : (
                            <span>{t("diff.contentSearchEmpty", { term: diffSearch.term, scope: diffSearch.scopeItems })}</span>
                          )}
                          {diffSearch.capped && (
                            <span className="batch-diff-search-capped">
                              {t("diff.contentSearchCapped", { max: MAX_DIFF_SEARCH_ITEMS, scope: diffSearch.scopeItems })}
                            </span>
                          )}
                        </div>
                        <div className="batch-diff-search-actions">
                          <label className="batch-diff-search-filter">
                            <input
                              type="checkbox"
                              checked={onlyHitItems}
                              onChange={(event) => setOnlyHitItems(event.target.checked)}
                            />
                            <span>{t("diff.contentSearchOnlyHits")}</span>
                          </label>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={clearContentSearch}>
                            {t("diff.contentSearchClear")}
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="batch-diff-nav-scroll" ref={batchNavScrollRef}>
                      {visibleBatchResults.map((item) => {
                        const stats = batchResultStatsMap[item.dataId] ?? batchResultStats(item.leftText, item.rightText);
                        const active = item.dataId === selectedBatchItem?.dataId;
                        const hit = isContentSearchActive ? diffSearchHitsById.get(item.dataId) : undefined;
                        // 片段取「先有命中的那一侧」：A 侧没有就是 B 侧新增的值，左右任一命中都该看得见
                        const hitSnippet = hit ? hit.left.snippet || hit.right.snippet : "";
                        const hitLine = hit ? hit.left.line || hit.right.line : 0;
                        return (
                          <button
                            type="button"
                            className={`batch-diff-nav-item${active ? " active" : ""}`}
                            key={item.dataId}
                            onClick={() => setSelectedBatchDataId(item.dataId)}
                            aria-current={active ? "true" : undefined}
                          >
                            <div className="batch-diff-nav-top">
                              <span className="batch-diff-nav-title" title={item.dataId}>
                                {item.dataId}
                              </span>
                              <div className="diff-stats batch-diff-nav-stats" aria-label={t("diff.diffStats")}>
                                <span className="stat stat-add">{t("diff.statAdded", { count: stats.added })}</span>
                                <span className="stat stat-del">{t("diff.statDeleted", { count: stats.removed })}</span>
                                <span className="stat stat-mod">{t("diff.statModified", { count: stats.modified })}</span>
                              </div>
                            </div>
                            <div className="batch-diff-nav-meta">
                              <span className={`batch-diff-presence ${item.presence}`}>{matchPresenceLabel(item.presence)}</span>
                            </div>
                            {hit && (
                              <div className="batch-diff-nav-hit">
                                <span
                                  className="batch-diff-nav-hit-count"
                                  title={t("diff.contentSearchBadgeHint", {
                                    leftLabel: item.leftLabel,
                                    rightLabel: item.rightLabel,
                                    a: hit.left.count,
                                    b: hit.right.count,
                                  })}
                                >
                                  {t("diff.contentSearchBadge", { a: hit.left.count, b: hit.right.count })}
                                </span>
                                <span className="batch-diff-nav-hit-line">{t("diff.contentSearchLine", { line: hitLine })}</span>
                              </div>
                            )}
                            {hit && hitSnippet && (
                              <div
                                className="batch-diff-nav-snippet"
                                title={hitSnippet}
                                dangerouslySetInnerHTML={{ __html: highlightSearchTerm(hitSnippet, diffSearch.term) }}
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </aside>

                  <section className="batch-diff-main">
                    {selectedBatchItem ? (
                      <>
                        <div className="batch-diff-main-head">
                          <div className="batch-diff-main-title-wrap">
                            <span className="batch-diff-main-title" title={selectedBatchItem.dataId}>
                              {selectedBatchItem.dataId}
                            </span>
                            <span className={`batch-diff-presence ${selectedBatchItem.presence}`}>
                              {matchPresenceLabel(selectedBatchItem.presence)}
                            </span>
                            {tunedDataIds.has(selectedBatchItem.dataId) && (
                              <span className="tune-badge" title={t("diff.manualTuneBadgeHint")}>
                                {t("diff.manualTuneBadge")}
                              </span>
                            )}
                          </div>
                          <div className="batch-diff-main-meta">
                            <span className="batch-diff-main-label" title={selectedBatchItem.leftLabel}>
                              {selectedBatchItem.leftLabel}
                            </span>
                            <span aria-hidden="true">{"\u2194"}</span>
                            <span className="batch-diff-main-label" title={selectedBatchItem.rightLabel}>
                              {selectedBatchItem.rightLabel}
                            </span>
                            {selectedBatchItem.presence === "right-only" ? (
                              <span className="btn-guard" title={t("diff.manualTuneUnavailableRightOnly")}>
                                <button type="button" className="btn btn-ghost btn-sm tune-toggle" disabled>
                                  {t("diff.manualTune")}
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                className={`btn btn-ghost btn-sm tune-toggle${batchTuneOpen ? " active" : ""}`}
                                aria-pressed={batchTuneOpen}
                                onClick={() => handleBatchTune(selectedBatchItem)}
                              >
                                {batchTuneOpen ? t("diff.manualTuneEditing") : t("diff.manualTune")}
                              </button>
                            )}
                          </div>
                        </div>
                        {batchTuneOpen && tuneDrafts[selectedBatchTuneKey as string] && (
                          <TargetTunePanel
                            label={selectedBatchItem.rightLabel}
                            format={selectedBatchItem.format}
                            active={active}
                            draft={tuneDrafts[selectedBatchTuneKey as string]}
                            onDraftChange={(next) => writeTuneDraft(batchTuneKey(selectedBatchItem.dataId), next)}
                            onSave={() => commitBatchTune(selectedBatchItem)}
                            onCancel={closeTuneEditor}
                            onReset={() => resetBatchTune(selectedBatchItem)}
                            resetDisabled={!tunedDataIds.has(selectedBatchItem.dataId) && !mergePreviews[selectedBatchItem.dataId]}
                            notice={tuneNotice ?? undefined}
                          />
                        )}
                        <DiffPanel
                          leftLabel={selectedBatchItem.leftLabel}
                          rightLabel={selectedBatchItem.rightLabel}
                          leftText={mergePreviewForItem(selectedBatchItem, mergePreviews).leftText}
                          rightText={mergePreviewForItem(selectedBatchItem, mergePreviews).rightText}
                          format={selectedBatchItem.format}
                          active={active}
                          searchTerm={isContentSearchActive ? contentSearchTerm : undefined}
                          warnings={batchWarningsForItem(selectedBatchItem, mergePreviews, t)}
                          onlyChanges={batchOnlyChanges.has(selectedBatchItem.dataId)}
                          onOnlyChangesChange={(checked) => toggleItemOnlyChanges(selectedBatchItem.dataId, checked)}
                          mergeActionLabels={{
                            leftToRight: t("diff.mergeAddToRightPlan"),
                          }}
                          mergeActionScope={mergeSelectionScope}
                          mergeActionAvailability={mergeAvailabilityForPresence(selectedBatchItem.presence)}
                          // 右侧独有项的箭头点不动，理由只能挂在提示上（这颗箭头是 icon-only）
                          mergeActionUnavailableReason={
                            selectedBatchItem.presence === "right-only" ? t("diff.mergeUnavailableRightOnly") : undefined
                          }
                          getMergeActionState={(rowIndex) => {
                            const direction = mergeSelections[mergeSelectionKey(selectedBatchItem.dataId, rowIndex)];
                            return direction ? { direction } : undefined;
                          }}
                          onMergeAction={(rowIndex, direction, rowIndexes) =>
                            setMergeSelection(selectedBatchItem.dataId, rowIndex, direction, rowIndexes)
                          }
                        />
                      </>
                    ) : (
                      <div className="pad-msg big">{t("diff.batchSelectHint")}</div>
                    )}
                  </section>
                </div>
              </div>
            )}

            {!matchResults && ready ? (
              <>
                {singleTuneOpen && tuneDrafts[SINGLE_TUNE_KEY] && (
                  <TargetTunePanel
                    label={rightLoaded.label}
                    format={singleTuneFormat}
                    active={active}
                    draft={tuneDrafts[SINGLE_TUNE_KEY]}
                    onDraftChange={(next) => writeTuneDraft(SINGLE_TUNE_KEY, next)}
                    onSave={commitSingleTune}
                    onCancel={closeTuneEditor}
                    onReset={resetSingleTune}
                    resetDisabled={!singleTune}
                    notice={undefined}
                  />
                )}
                <DiffPanel
                  leftLabel={leftLoaded.label}
                  rightLabel={rightLoaded.label}
                  leftText={leftText}
                  // 微调后显示人写的那一份，不是服务端原文：用户要看得见自己写的落到结果里（R1）。
                  rightText={effectiveSingleRightText}
                  format={diffFormat}
                  active={active}
                  warnings={singleWarnings}
                />
              </>
            ) : !matchResults && !ready ? (
              <div className="pad-msg big">
                {t("diff.selectHint")}
                <div className="diff-hint">{t("diff.supportHint")}</div>
                <div className="diff-hint">{t("diff.nextStepHint")}</div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {/*
        丢弃手写正文的二次确认（轮60 R7）。danger 档：这一步之后手写的字迹找不回来，
        服务端原文会重新成为要写出去的内容。走应用内 ConfirmModal，不用原生 confirm()。
      */}
      {tuneDiscardPending && (
        <ConfirmModal
          danger
          active={active}
          title={t("diff.manualTuneDiscardTitle")}
          message={t("diff.manualTuneDiscardMessage")}
          confirmLabel={t("diff.manualTuneDiscardConfirm")}
          onConfirm={() => {
            const pending = tuneDiscardPending;
            setTuneDiscardPending(null);
            if (pending.scope === "single") {
              discardSingleTune();
              return;
            }
            const item = batchResults.find((row) => row.dataId === pending.dataId);
            if (item) discardBatchTune(item);
          }}
          onCancel={() => setTuneDiscardPending(null)}
        />
      )}
    </div>
  );
}

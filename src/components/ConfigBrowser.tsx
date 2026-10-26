import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Connection, connectionDisplayLabel, connectionProjectName } from "../store/connections";
import { ConfigItem, getConfig, getConfigDocument, listConfigs, type ConfigDocument } from "../api/nacos";
import type { ApplyEntryEndpoint, ApplyEntryPayload } from "../lib/applyEntry";
import { busyProps } from "../lib/busyRegion";
import {
  buildContentReplaceApplyEntry,
  replacementImpact,
  highlightSearchTerm,
  searchConfigContent,
  type ContentSearchResult,
} from "../lib/configContentSearch";
import { buildDirectWriteExitEntry, isWritableConfigTarget } from "../lib/directWriteExit";
import { effectiveProvider, supportsConfigHistory } from "../lib/configCapabilities";
import { localRevisionStoreAvailable } from "../lib/configRevisions";
import { BATCH_READ_CONCURRENCY, mapWithConcurrency } from "../lib/concurrency";
import { detectFormat, Format, FORMATS } from "../lib/format";
import { reportError } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import { validateConfigIssues } from "../lib/validate";
import { useTranslation } from "../i18n";
import { connectionLabel } from "../lib/defaultNameCopy";
import { useDeferredSearchInput } from "../lib/deferredSearchInput";
import { exportConfigs, type ConfigExportOptions } from "../lib/export";
import { createSnapshotFromConfigs } from "../api/snapshot";
import { exportConfigSourceFiles, selectConfigSourceExportDirectory } from "../api/app";
import { useTaskManager } from "../lib/taskmanager";
import { recordOperation } from "../store/operationHistory";
import { EscapePriority, isImeComposing, useEscape } from "../lib/useEscape";
import { useDialogFocus } from "../lib/useDialogFocus";
import { useOverlayDismiss } from "../lib/useOverlayDismiss";
import { useWheelColumnResolver, useWheelSurface } from "../lib/useWheelColumnResolver";
import AlertModal, { type AlertItem } from "./AlertModal";
import CodeEditor, { type CodeEditorHandle } from "./CodeEditor";
import ConfirmModal from "./ConfirmModal";
import CodeView from "./CodeView";
import ConfigEditor from "./ConfigEditor";
import CopyButton from "./CopyButton";
import InlineError from "./InlineError";
import DeleteConfirm from "./DeleteConfirm";
import ConfigHistoryPanel from "./ConfigHistoryPanel";
import Pager from "./Pager";
import Select from "./Select";
import { errorText } from "../lib/errorText";
import {
  changeTouchesConfig,
  changeTouchesNamespace,
  subscribeConfigChanges,
  type ConfigChangeNotice,
} from "../lib/configChangeBus";
import { statusMessageProps } from "../lib/statusSemantics";

interface Props {
  conn: Connection;
  tenant: string;
  connections?: Connection[];
  onStartApply?: (payload: ApplyEntryPayload) => void;
  /**
   * 页面是否处于前台。App 为保活把整页 hidden 起来（切到其他模式）时传 false：
   * 实例不卸载，但全局键盘职责要一并交还，避免隐藏的编辑态/弹层吃掉 Esc、
   * 隐藏的 CodeView 劫持 Ctrl+F。默认 true，单测与其他调用方无需改动。
   */
  active?: boolean;
}

const PAGE_SIZE = 50;
type Tab = "content" | "history";
type SearchMode = "dataId" | "content";
type ConfigMetadata = Pick<ConfigDocument, "version" | "source" | "updateTime">;

function configResultKey(item: Pick<ConfigItem, "dataId" | "group">): string {
  return `${item.group}\u0000${item.dataId}`;
}

function isSandboxEnvironment(conn: Connection): boolean {
  return /sandbox|沙箱/i.test(`${conn.name} ${conn.environmentName ?? ""} ${conn.sourceName ?? ""} ${(conn.tags ?? []).join(" ")}`);
}

type BrowserToolIconName = "refresh" | "add" | "download";

const browserToolIconPath: Record<BrowserToolIconName, string[]> = {
  refresh: ["M19 7v5h-5", "M18 12a6 6 0 10-1.8 4.2", "M19 12l-3.5-3.5"],
  add: ["M12 5v14", "M5 12h14"],
  download: ["M12 4v11", "M7 10l5 5 5-5", "M5 20h14"],
};

function BrowserToolIcon({ name }: { name: BrowserToolIconName }) {
  return (
    <svg className="browser-tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      {browserToolIconPath[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** 配置浏览：左侧配置列表（dataId 或内容搜索），右侧内容 / 历史标签页。 */
export default function ConfigBrowser({ conn, tenant, connections = [], onStartApply, active = true }: Props) {
  const { t } = useTranslation();
  const taskManager = useTaskManager();
  const [search, setSearch] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("dataId");
  const [appliedTerm, setAppliedTerm] = useState(""); // 已生效的搜索词（翻页时复用）
  const [contentTerm, setContentTerm] = useState("");
  const [contentResults, setContentResults] = useState<ContentSearchResult[]>([]);
  const [contentSearchProgress, setContentSearchProgress] = useState({ loaded: 0, total: 0, failed: 0 });
  const [contentSearchError, setContentSearchError] = useState<string | null>(null);
  // 内容扫描进行中：此时结果为空是「还没扫完」，不能当成「没有命中」播报给用户。
  const [contentSearching, setContentSearching] = useState(false);
  const [selectedContentKeys, setSelectedContentKeys] = useState<Set<string>>(new Set());
  const [showReplace, setShowReplace] = useState(false);
  const [showTargetPicker, setShowTargetPicker] = useState(false);
  const [replaceFindText, setReplaceFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [targetConnectionId, setTargetConnectionId] = useState("");
  const [targetNamespace, setTargetNamespace] = useState(tenant);
  // 初始 group：跟随连接的默认 group（空/DEFAULT_GROUP 视为不限制，显示全部）
  const [selectedGroup, setSelectedGroup] = useState(() => {
    const g = (conn?.defaultGroup ?? "").trim();
    return g === "" || g === "DEFAULT_GROUP" ? "" : g;
  });
  const [knownGroups, setKnownGroups] = useState<string[]>([]);
  const [items, setItems] = useState<ConfigItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageNo, setPageNo] = useState(1);
  const [pages, setPages] = useState(1);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selected, setSelected] = useState<ConfigItem | null>(null);
  const [content, setContent] = useState("");
  const [metadata, setMetadata] = useState<ConfigMetadata | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("content");
  // fmt 为当前格式（驱动语法高亮 / 发布时的 type）
  const [fmt, setFmt] = useState<Format>("TEXT");
  // 编辑 / 新建 / 删除
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [snapshotSaving, setSnapshotSaving] = useState(false);
  // 源文件导出要先等用户在本机目录对话框里选路径，这段时间动作仍在途，按钮必须锁住
  const [sourceExporting, setSourceExporting] = useState(false);
  // 编辑中有未保存改动时，切换配置先确认；pending 保存待执行的跳转动作
  const [pending, setPending] = useState<(() => void) | null>(null);
  // 这次待确认的去向会不会真的换配置：换配置与只退出编辑态共用一个确认框，
  // 但两句文案不通用——「切换后将丢失」用在退出编辑态上就是假话，靠它取键。
  const [pendingSwitches, setPendingSwitches] = useState(true);
  const [validateErrs, setValidateErrs] = useState<AlertItem[]>([]);
  // 写后失效：选中项被计划删除/移走时清空选中，并在空态给出可见说明（不静默变空）
  const [removedByPlan, setRemovedByPlan] = useState<{ dataId: string; group: string } | null>(null);
  // 编辑态命令式入口：查找栏、以及校验错误「跳到第 N 行」的落点（R22 / R28）
  const editorRef = useRef<CodeEditorHandle>(null);
  /**
   * 滚轮兜底的两个角色（轮33 F-34）：`.browser` 是这一页的根（`.page-header` 在它外面，天然不接），
   * `.browser-items` 是左列唯一的滚动容器——`research/p4_browse_chrome.txt` 实测出
   * `.browser-search` / `.browser-search-mode` / `.browser-count` 三块（含右下角那块空隙）
   * 既不在它子树里、自己也没有滚动容器，祖先链零可滚容器 ⇒ 滚轮一格都不动（页内死区 22.2% 视口）。
   */
  const browserRootRef = useRef<HTMLDivElement>(null);
  const itemsScrollRef = useRef<HTMLDivElement>(null);
  // 写后失效要用「重取后服务端到底还有哪些配置」来判断选中项是否真被删掉，
  // 而这些值是取数函数在 await 之后才落进 state 的（闭包里读到的是上一轮的），故另存镜像。
  const itemsRef = useRef<ConfigItem[]>([]);
  const contentScopeItemsRef = useRef<ConfigItem[]>([]);
  const lastReloadOk = useRef(false);
  const pendingStaleRef = useRef<ConfigChangeNotice[]>([]);
  useWheelColumnResolver(browserRootRef);
  // 列表行高不固定（摘要会换行），所以不给 rowHeight：deltaMode=1（Linux 上 WebKitGTK 常见）
  // 按 wheelScroll 的默认基数换算，宁可一格少滚一点，也不要按一个猜不准的行高把列表甩出半屏。
  useWheelSurface(itemsScrollRef);
  const dirty = editing && draft !== content;
  const isLocalSnapshot = conn.sourceType === "local-snapshot";
  /**
   * 「历史变更」tab 的出现条件（轮67 R57-WP15 改口径，R8）。
   *
   * 轮55 R55-E2 那条收口仍然成立：Apollo/Consul 的 ListHistory 在 Go 侧直接返回
   * 「当前为只读模式」，所以**服务端**那一档照旧按 supportsConfigHistory 决定出不出现。
   * tab 本身放宽到「服务端能给 或 本机存储可达」：本机历史正是由用户刚才那次读取写进去的
   * （fire-and-forget），拿「本机是否已有这个键的记录」当闸门会让 tab 忽隐忽现，
   * 所以闸门只看存储可达不可达，面板内部用诚实空态 + 重新读取兜住「刚记上还来不及列出来」。
   */
  const canBrowseHistory = supportsConfigHistory(conn) || localRevisionStoreAvailable();
  const isContentSearchActive = searchMode === "content" && Boolean(contentTerm);
  const visibleItems = isContentSearchActive ? contentResults.map((result) => result.item) : items;
  const selectedContentResults = contentResults.filter((result) => selectedContentKeys.has(configResultKey(result.item)));
  const replaceImpact = replacementImpact(selectedContentResults, replaceFindText, replaceText);
  /**
   * 这个连接能不能作为变更计划的目标。轮42 起它还决定「编辑 / 删除 / 新建配置」三个入口出不出：
   * 只读连接与本地快照挂着「点了永远不可能成功」的写入口，比少一个按钮更糟（R42-8）。
   */
  const canWrite = isWritableConfigTarget(conn);
  const canStartReplacement = Boolean(onStartApply) && canWrite;
  const connectionName = conn.name || connectionLabel(conn, t);
  const namespaceLabel = tenant || "public";
  const sourceLabel = `${connectionName} / ${namespaceLabel}`;
  const targetConnections = useMemo(
    () =>
      connections
        .filter(
          (candidate) =>
            connectionProjectName(candidate) === connectionProjectName(conn) && isWritableConfigTarget(candidate)
        )
        .sort(
          (left, right) =>
            Number(isSandboxEnvironment(right)) - Number(isSandboxEnvironment(left)) ||
            connectionDisplayLabel(left).localeCompare(connectionDisplayLabel(right))
        ),
    [conn, connections]
  );
  const targetConnection = targetConnections.find((candidate) => candidate.id === targetConnectionId) ?? null;
  const sourceEndpoint: ApplyEntryEndpoint = {
    provider: conn.provider ?? "nacos",
    connectionId: conn.id,
    connectionName,
    namespace: tenant,
    label: `${connectionLabel(conn, t)} / ${namespaceLabel}`,
  };
  const metadataItems =
    isLocalSnapshot && metadata
      ? [
          { label: t("config.updateTime"), value: metadata.updateTime },
          { label: t("config.version"), value: metadata.version },
          { label: t("config.source"), value: metadata.source },
        ].filter((item) => item.value)
      : [];
  /**
   * 有未保存草稿时先确认再执行 action，确认无草稿时直接执行。
   *
   * switches 只描述去向，不改变拦截条件：
   * - true（默认）：action 会把用户带去另一个配置 → 确认框说「切换后将丢失这些改动」。
   * - false：action 只收起编辑态、人还停在当前配置 → 确认框说「放弃后这些改动会丢失」。
   * 拦截口径与轮90 之前完全一致，改的只是弹框里那两句要不要跟着动作走。
   */
  const guardNav = (action: () => void, switches = true) => {
    if (dirty) {
      setPendingSwitches(switches);
      setPending(() => action);
    } else {
      action();
    }
  };
  const rememberGroups = (list: ConfigItem[], fallbackGroup?: string) => {
    const extraGroup = fallbackGroup?.trim();
    setKnownGroups((prev) => {
      const next = new Set(prev);
      for (const item of list) {
        const group = item.group.trim();
        if (group) next.add(group);
      }
      if (extraGroup) next.add(extraGroup);
      const sorted = [...next].sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
      if (sorted.length === prev.length && sorted.every((value, index) => value === prev[index])) return prev;
      return sorted;
    });
  };
  const groupOptions = useMemo(() => {
    const groups = selectedGroup.trim() && !knownGroups.includes(selectedGroup) ? [selectedGroup, ...knownGroups] : knownGroups;
    return [{ value: "", label: t("config.allGroups") }, ...groups.map((group) => ({ value: group, label: group }))];
  }, [knownGroups, selectedGroup, t]);

  // 列表请求序号：防止快速搜索/刷新时旧结果覆盖新结果。
  const listReqId = useRef(0);
  const contentSearchReqId = useRef(0);

  const clearContentSearch = () => {
    contentSearchReqId.current += 1;
    setContentSearching(false);
    setContentTerm("");
    setContentResults([]);
    setContentSearchProgress({ loaded: 0, total: 0, failed: 0 });
    setContentSearchError(null);
    setSelectedContentKeys(new Set());
    contentScopeItemsRef.current = [];
    setShowReplace(false);
    setShowTargetPicker(false);
  };

  const searchAllContent = async (term: string, groupFilter = selectedGroup) => {
    const query = term.trim();
    if (!query) {
      clearContentSearch();
      fetchList("", 1, groupFilter);
      return;
    }

    const my = ++contentSearchReqId.current;
    const group = groupFilter.trim();
    lastReloadOk.current = false;
    setContentSearching(true);
    setContentTerm(query);
    setContentResults([]);
    setContentSearchProgress({ loaded: 0, total: 0, failed: 0 });
    setContentSearchError(null);
    setSelectedContentKeys(new Set());
    try {
      // 这里按 pagesAvailable 聚合翻页（判页数不能信被 group 过滤改写过的 totalCount）。
      // 其它调用点「取全列表」请直接用 api 层的 listAllConfigs（见 R1）；
      // 本处保留自有的逐页进度语义，PAGE_SIZE=50 的枚举成本归入 P2 backlog。
      const firstPage = await listConfigs(conn, tenant, "", group, 1, PAGE_SIZE);
      if (my !== contentSearchReqId.current) return;
      const allItems = [...firstPage.pageItems];
      const pageCount = Math.max(firstPage.pagesAvailable || 1, 1);
      for (let page = 2; page <= pageCount; page += 1) {
        const nextPage = await listConfigs(conn, tenant, "", group, page, PAGE_SIZE);
        if (my !== contentSearchReqId.current) return;
        allItems.push(...nextPage.pageItems);
      }
      contentScopeItemsRef.current = allItems;
      setContentSearchProgress({ loaded: 0, total: allItems.length, failed: 0 });

      const loaded = await mapWithConcurrency(allItems, BATCH_READ_CONCURRENCY, async (item) => {
        try {
          const document = await getConfigDocument(conn, tenant, item.dataId, item.group);
          return { item, document, error: "" };
        } catch (error) {
          return { item, document: null, error: errorText(error) };
        } finally {
          if (my === contentSearchReqId.current) {
            setContentSearchProgress((current) => ({
              ...current,
              loaded: current.loaded + 1,
            }));
          }
        }
      });
      if (my !== contentSearchReqId.current) return;
      const failures = loaded.filter((result) => result.error);
      const documents = loaded.flatMap((result) => (result.document ? [{ item: result.item, document: result.document }] : []));
      const results = searchConfigContent(documents, query);
      setContentResults(results);
      lastReloadOk.current = true;
      setSelectedContentKeys(new Set(results.map((result) => configResultKey(result.item))));
      setContentSearchProgress({ loaded: allItems.length, total: allItems.length, failed: failures.length });
      if (failures.length) {
        setContentSearchError(failures.map((result) => `${result.item.group}/${result.item.dataId}: ${result.error}`).join("\n"));
      }
    } catch (error) {
      if (my !== contentSearchReqId.current) return;
      const message = errorText(error);
      setContentSearchError(message);
      reportError({
        title: t("config.contentSearchFailed"),
        source: sourceLabel,
        message,
        detail: message,
        actionLabel: t("common.retry"),
        onAction: () => searchAllContent(query, group),
      });
    } finally {
      if (my === contentSearchReqId.current) setContentSearching(false);
    }
  };

  const fetchList = async (term: string, page: number, groupFilter = selectedGroup) => {
    const my = ++listReqId.current;
    const group = groupFilter.trim();
    lastReloadOk.current = false;
    setListLoading(true);
    setListError(null);
    setAppliedTerm(term);
    setPageNo(page);
    try {
      // blur 搜索：用 *term* 模糊匹配 dataId；term 为空则列全部
      const dataId = term.trim() ? `*${term.trim()}*` : "";
      const res = await listConfigs(conn, tenant, dataId, group, page, PAGE_SIZE);
      if (my !== listReqId.current) return;
      itemsRef.current = res.pageItems;
      setItems(res.pageItems);
      rememberGroups(res.pageItems, group);
      setTotal(res.totalCount);
      setPages(Math.max(res.pagesAvailable || 1, 1));
      lastReloadOk.current = true;
    } catch (e) {
      if (my !== listReqId.current) return;
      const message = errorText(e);
      setListError(message);
      itemsRef.current = [];
      setItems([]);
      setTotal(0);
      setPages(1);
      reportError({
        title: t("config.listLoadFailed"),
        source: sourceLabel,
        message,
        detail: message,
        actionLabel: t("common.retry"),
        onAction: () => fetchList(term, page, group),
      });
    } finally {
      if (my === listReqId.current) setListLoading(false);
    }
  };

  /**
   * 按当前搜索态重取——刷新按钮与写后失效共用这一个出口，
   * 免得「内容搜索模式下刷新该做什么」在两处各写一遍然后漂移。
   * 返回值 = 这次重取有没有真把数据取回来（取回来失败时不要顺手清掉用户的选中态）。
   */
  const reloadList = async (): Promise<boolean> => {
    lastReloadOk.current = false;
    if (searchMode === "content") await searchAllContent(search, selectedGroup);
    else await fetchList(appliedTerm, pageNo, selectedGroup);
    return lastReloadOk.current;
  };

  /**
   * 输入即搜：防抖 + 输入法闸门（轮66 WP-6，无需「搜索」按钮）。
   *
   * 口径是「回显永远即时，搜索永远等上屏」：组合期间每敲一个拼音字母都会派发 input，
   * 原来那层裸 setTimeout 会拿 `b`/`be`/`bei` 去查一遍——内容搜索模式还要把每份正文
   * 重扫一次，用户看到的是「我还没打完它就说搜不到」。Enter 与搜索按钮走 runNow，不等。
   */
  const deferredSearch = useDeferredSearchInput((v: string) => {
    if (searchMode === "content") searchAllContent(v, selectedGroup);
    else fetchList(v, 1, selectedGroup);
  });
  const onSearchChange = (v: string) => {
    setSearch(v);
    deferredSearch.schedule(v);
  };
  const searchNow = () => deferredSearch.runNow(search);

  // 空态里的「清除搜索条件」：搜索框、已生效词、内容搜索结果一起归零并回列表。
  // 不顺手收掉尚未触发的搜索的话，用户点完清除，400ms 后旧词又会把列表打回空态。
  const clearSearchTerms = () => {
    deferredSearch.cancel();
    setSearch("");
    if (searchMode === "content") searchAllContent("");
    else fetchList("", 1, selectedGroup);
  };
  const switchSearchMode = (mode: SearchMode) => {
    if (mode === searchMode) return;
    deferredSearch.cancel();
    setSearchMode(mode);
    if (mode === "content") searchAllContent(search, selectedGroup);
    else {
      clearContentSearch();
      fetchList(search, 1, selectedGroup);
    }
  };
  const onGroupChange = (group: string) => {
    guardNav(() => {
      deferredSearch.cancel();
      setSelectedGroup(group);
      setSelected(null);
      setContent("");
      setMetadata(null);
      setTab("content");
      if (searchMode === "content") searchAllContent(search, group);
      else fetchList(search, 1, group);
    });
  };

  // ── 列表键盘导航（R18）──
  // 列表项此前是裸 div：↑↓ 寄生在搜索框上，焦点一旦离开输入框就再也走不动，读屏也念不出条目。
  // 现在走 roving tabindex——整列只有一个 tabIndex=0（焦点行 > 选中行 > 首行），方向键在 listbox 容器上
  // 统一处理，Home/End 跳首末，Enter 兜住「焦点行不是选中行」那一种。
  // 保留「移动即打开」的自动激活，不改成「移动 + Enter」：↑↓ 预览是用户已有的肌肉记忆，
  // 换成手动激活等于悄悄改掉既有语义；代价是按一次拉一次正文，靠已有的请求序号收敛掉过期响应。
  // 走动的是 visibleItems 而不是 items：内容搜索态下屏幕上就是命中项，箭头却曾经过滤前的旧列表——
  // 那会打开一行根本没显示的配置。
  const listItemKey = (it: ConfigItem) => `${it.group}/${it.dataId}`;
  const selectedKey = selected ? listItemKey(selected) : null;
  const [focusedItemKey, setFocusedItemKey] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const bindItemRef = (key: string) => (el: HTMLDivElement | null) => {
    if (el) itemRefs.current.set(key, el);
    else itemRefs.current.delete(key);
  };
  const rovingItemKey =
    [focusedItemKey, selectedKey, visibleItems.length ? listItemKey(visibleItems[0]) : null].find((key) =>
      key ? visibleItems.some((it) => listItemKey(it) === key) : false
    ) ?? null;

  useEffect(() => {
    if (!focusedItemKey) return;
    const el = itemRefs.current.get(focusedItemKey);
    // 只有键盘在列表内走动才挪 DOM 焦点；从搜索框预览时输入框必须留住，用户还要接着改查询词。
    if (el && el !== document.activeElement) el.focus({ preventScroll: true });
  }, [focusedItemKey]);

  const navigateList = (index: number, moveFocus: boolean) => {
    if (!visibleItems.length) return;
    const it = visibleItems[Math.min(Math.max(index, 0), visibleItems.length - 1)];
    if (moveFocus) setFocusedItemKey(listItemKey(it));
    guardNav(() => openConfig(it));
  };

  // 搜索框触发 moveFocus=false（只预览），列表内触发 true（焦点随行走）。
  const moveSelection = (delta: number, moveFocus = false) => {
    const baseKey = moveFocus ? (focusedItemKey ?? selectedKey) : selectedKey;
    const idx = baseKey ? visibleItems.findIndex((it) => listItemKey(it) === baseKey) : -1;
    if (idx < 0) {
      navigateList(delta > 0 ? 0 : visibleItems.length - 1, moveFocus);
      return;
    }
    navigateList(idx + delta, moveFocus);
  };

  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(e)) return; // 组合态的方向键与回车归输入法
    const key = focusedItemKey ?? selectedKey;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1, true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1, true);
    } else if (e.key === "Home") {
      e.preventDefault();
      navigateList(0, true);
    } else if (e.key === "End") {
      e.preventDefault();
      navigateList(visibleItems.length - 1, true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = key && key !== selectedKey ? visibleItems.find((item) => listItemKey(item) === key) : undefined;
      if (it) guardNav(() => openConfig(it));
    }
  };
  // 选中项滚入可视区。
  // 保活隐藏（display:none）期间 Chromium 会直接丢弃 scrollIntoView（真机实测），
  // 所以记下最后一次对齐过的选中项；切回前台时若选中项已在隐藏期间变掉，补一次对齐，
  // 没变过就什么都不做——列表滚动位置本身是保活的，不能把用户翻到的地方拽回去。
  const alignedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    if (selectedKey === alignedKeyRef.current) return;
    alignedKeyRef.current = selectedKey;
    if (selectedKey) itemRefs.current.get(selectedKey)?.scrollIntoView({ block: "nearest" });
  }, [active, selectedKey]);

  // 切换连接 / 命名空间时重置并重新拉列表
  useEffect(() => {
    contentSearchReqId.current += 1;
    setSearch("");
    setSearchMode("dataId");
    setContentTerm("");
    setContentResults([]);
    setContentSearchProgress({ loaded: 0, total: 0, failed: 0 });
    setContentSearchError(null);
    setSelectedContentKeys(new Set());
    const resetGroup = (conn.defaultGroup ?? "").trim();
    const resetGroupValue = resetGroup === "" || resetGroup === "DEFAULT_GROUP" ? "" : resetGroup;
    setSelectedGroup(resetGroupValue);
    setKnownGroups([]);
    setSelected(null);
    setContent("");
    setMetadata(null);
    setTab("content");
    setShowNew(false);
    setShowReplace(false);
    setShowTargetPicker(false);
    setReplaceFindText("");
    setReplaceText("");
    setTargetNamespace(tenant);
    fetchList("", 1, resetGroupValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, tenant]);

  useEffect(() => {
    const preferred = targetConnections.find(isSandboxEnvironment) ?? targetConnections[0];
    setTargetConnectionId(preferred?.id ?? "");
    setTargetNamespace(tenant);
  }, [targetConnections, tenant]);

  // 每次打开配置自增，异步结果只在仍是最新一次请求时才采用，避免连点串台。
  const reqId = useRef(0);

  const openConfig = async (item: ConfigItem) => {
    const my = ++reqId.current;
    setSelected(item); // 立即高亮，与异步内容加载解耦；切换配置保持当前标签页
    setRemovedByPlan(null);
    setContentLoading(true);
    setContentError(null);
    setContent("");
    setMetadata(null);
    try {
      const document = await getConfigDocument(conn, tenant, item.dataId, item.group);
      if (my !== reqId.current) return; // 已有更晚的点击，丢弃本次结果
      setContent(document.content);
      setMetadata({ version: document.version, source: document.source, updateTime: document.updateTime });
      setFmt(detectFormat(item.dataId, document.format || item.configType, document.content));
    } catch (e) {
      if (my !== reqId.current) return;
      const message = errorText(e);
      setContentError(message);
      setContent("");
      setMetadata(null);
      reportError({
        title: t("config.contentLoadFailed"),
        source: `${sourceLabel} / ${item.group} / ${item.dataId}`,
        message,
        detail: message,
        actionLabel: t("common.retry"),
        onAction: () => openConfig(item),
      });
    } finally {
      if (my === reqId.current) setContentLoading(false);
    }
  };

  // 切换配置时退出编辑/删除态
  useEffect(() => {
    setEditing(false);
    setSaveError(null);
    setShowDelete(false);
  }, [selected?.dataId, selected?.group]);

  /**
   * 写后失效（轮43）。本页被 App.tsx 的 `.browse-cache` 保活：切去其他模式只是 display:none，
   * 不卸载也不重新取数，而全站唯一的写路径（变更计划执行器）在另一棵子树里改的是服务端。
   * 结果就是界面刚提示「变更执行完成」，切回来正文/列表还是执行前那一刻——
   * 用户只能理解成「没写进去」，于是重复生成计划、重复执行。
   *
   * 处置：在前台立刻按当前搜索态重取一次；被隐藏时只欠一笔通知，等切回前台合并补做，
   * 隐藏期不发请求（保住保活的收益，也与 display:none 下 scrollIntoView 会被 Chromium
   * 丢弃那条实测口径一致）。重取一律复用 reloadList / openConfig，不新造第二套取数逻辑。
   */
  const flushStale = async (notices: ConfigChangeNotice[]) => {
    setRemovedByPlan(null);
    const target = selected;
    const reloaded = await reloadList();
    if (!target || !reloaded) return; // 列表没取回来就别动用户的选中态
    // 只重取「确实被这次写入碰过」的那一份：其余正文没变，草稿与编辑态原样留着。
    const touched = notices.some((notice) =>
      changeTouchesConfig(notice, { connectionId: conn.id, namespace: tenant, dataId: target.dataId, group: target.group })
    );
    if (!touched) return;
    // 内容搜索态下命中集是按搜索词过滤的，判「还在不在」要用那次枚举到的全集。
    const pool = searchMode === "content" ? contentScopeItemsRef.current : itemsRef.current;
    if (pool.some((item) => configResultKey(item) === configResultKey(target))) {
      void openConfig(target); // 正文改由服务端真值重新填，dirty 会随之重算
      return;
    }
    setSelected(null);
    setContent("");
    setMetadata(null);
    setEditing(false);
    setRemovedByPlan({ dataId: target.dataId, group: target.group });
  };
  // flushStale 每轮渲染都是新闭包（要读最新的搜索态/选中项），用 ref 拿最新那份再调。
  const flushStaleRef = useRef(flushStale);
  useEffect(() => {
    flushStaleRef.current = flushStale;
  });
  const flushPendingStale = () => {
    const notices = pendingStaleRef.current;
    if (!notices.length) return;
    pendingStaleRef.current = [];
    void flushStaleRef.current(notices);
  };
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
    if (active) flushPendingStale(); // 切回前台补做隐藏期间欠下的刷新
  }, [active]);
  useEffect(() => {
    const unsubscribe = subscribeConfigChanges((notice) => {
      if (!changeTouchesNamespace(notice, conn.id, tenant)) return;
      pendingStaleRef.current.push(notice);
      if (activeRef.current) flushPendingStale();
    });
    return unsubscribe;
    // 只按连接/命名空间注册一次：App 给本页的 key 就是这两者，切过去本来就重挂载。
  }, [conn.id, tenant]);

  const startEdit = () => {
    setDraft(content);
    setEditing(true);
    setSaveError(null);
  };

  const toggleContentResult = (result: ContentSearchResult) => {
    const key = configResultKey(result.item);
    setSelectedContentKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const openReplacePanel = () => {
    setReplaceFindText(search.trim());
    setReplaceText("");
    setShowReplace(true);
  };

  const openTargetPicker = () => {
    if (!replaceFindText) return;
    if (replaceImpact.configs === 0) return;
    setShowReplace(false);
    setShowTargetPicker(true);
  };

  const startContentReplaceApply = () => {
    if (!targetConnection || !onStartApply) return;
    const targetLabel = `${connectionLabel(targetConnection, t)} / ${targetNamespace || "public"}`;
    const entry = buildContentReplaceApplyEntry({
      source: sourceEndpoint,
      target: {
        provider: targetConnection.provider ?? "nacos",
        connectionId: targetConnection.id,
        connectionName: targetConnection.name || connectionLabel(targetConnection, t),
        namespace: targetNamespace,
        label: targetLabel,
      },
      results: selectedContentResults,
      findText: replaceFindText,
      replaceText,
    });
    if (!entry) return;
    setShowTargetPicker(false);
    onStartApply(entry);
  };

  /**
   * 「保存」= 把编辑区里的草稿物化成变更计划（轮42 / 方案 D）。
   *
   * 这里不再假装能直写：直写在 API 层是硬禁用（fd074a8），以前点一下必然失败，
   * 还要往操作历史里塞一条 `result:"failure"` 的假记录，把「你没做错」渲染成「你失败了」。
   * 现在按钮说的就是它做的事，走的也是全站唯一那条 sanctioned 写入链路：
   * dry-run → 确认 → 执行（执行器自己记操作历史，所以这里一条都不记）。
   */
  const saveAsPlan = () => {
    if (!selected) return;
    const problems = validateConfigIssues(draft, fmt);
    if (problems.length) {
      setValidateErrs(problems.map((p) => ({ text: p.message, line: p.line }))); // 弹框提示并禁止生成计划
      return;
    }
    setSaveError(null);
    if (draft === content) {
      // 与线上正文一致：计划里只会有一个 skip 项，生成出来没有任何可执行内容，别浪费这一步。
      setSaveError(t("config.noChangeToPlan"));
      return;
    }
    const entry = buildDirectWriteExitEntry({
      conn,
      t,
      namespace: tenant,
      group: selected.group,
      dataId: selected.dataId,
      format: fmt,
      desiredContent: draft,
      intent: "edit",
    });
    if (!entry || !onStartApply) {
      setSaveError(t("config.planRouteUnavailable"));
      return;
    }
    onStartApply(entry);
    toast(t("config.planCreated"));
  };

  /**
   * 退出编辑态：有未保存改动时先经 guardNav 弹确认，绝不静默丢弃草稿。
   * Esc 与「取消」按钮共用这一条路径，保证两个入口行为一致。
   *
   * switches=false：这条路径只退出编辑态，正文回到服务端那份，不发生任何「切换」。
   */
  const cancelEditing = () => {
    setSaveError(null);
    guardNav(() => setEditing(false), false);
  };

  // 编辑态按 Esc 取消编辑；更高一层的弹层（新建/删除/确认/替换/目标选择/校验提示）打开时不参与。
  useEscape(
    active && editing && !showNew && !showDelete && !pending && !showReplace && !showTargetPicker && validateErrs.length === 0,
    cancelEditing,
    EscapePriority.page
  );

  // 批量替换 / 应用目标两个内联弹层支持 Esc（此前只能点遮罩关闭）。
  // 两步是互斥流程（进入目标选择时替换层已关闭），条件里的互斥判断是给未来嵌套留的余量；
  // 确认框（confirm 优先级）与弹层内下拉（dropdown 优先级）展开时，Esc 由它们先吃掉。
  useEscape(active && showReplace && !showTargetPicker && !pending, () => setShowReplace(false), EscapePriority.overlay);
  useEscape(active && showTargetPicker && !showReplace && !pending, () => setShowTargetPicker(false), EscapePriority.overlay);
  // 遮罩关闭走统一判定：在替换表单里选中文本拖出弹层，不再把填好的条件一起丢掉（R53）。
  const replaceOverlayDismiss = useOverlayDismiss(() => setShowReplace(false));
  const targetOverlayDismiss = useOverlayDismiss(() => setShowTargetPicker(false));

  // 这两个内联弹层也要有焦点陷阱：条件与上面两条 Esc 完全对齐，
  // 两层同时 active 会互相抢焦点（谁后挂载谁赢，Tab 环被拽到看不见的那层）。
  const replaceModalRef = useRef<HTMLDivElement>(null);
  const targetModalRef = useRef<HTMLDivElement>(null);
  const replaceTitleId = useId();
  const targetTitleId = useId();
  useDialogFocus({ active: active && showReplace && !showTargetPicker && !pending, containerRef: replaceModalRef });
  useDialogFocus({ active: active && showTargetPicker && !showReplace && !pending, containerRef: targetModalRef });

  // 保活隐藏（切到其他模式）时收敛「一次性、且再出现会很危险」的 UI 态：
  // 待确认的跳转闭包与删除确认框不能藏在后台——切回来突然弹确认、
  // 或对着已经变掉的选中项执行删除，都是事故。
  // 反过来，编辑草稿与批量替换这类「装了用户输入」的弹层要留着：
  // 整棵子树是 display:none，不会残留在屏幕上，切回来还能接着改，
  // 不像改造前那样切个 Tab 就把没保存的正文丢掉。
  useEffect(() => {
    if (active) return;
    setPending(null);
    setShowDelete(false);
  }, [active]);

  /**
   * 「删除」= 生成一条删除计划（由确认弹框调用，抛错交给弹框呈现）。
   * 期望内容是「不存在」，计划页把它渲染成删除项，真正删的动作仍在执行器那侧。
   */
  const deleteAsPlan = async () => {
    if (!selected) return;
    const entry = buildDirectWriteExitEntry({
      conn,
      t,
      namespace: tenant,
      group: selected.group,
      dataId: selected.dataId,
      format: fmt,
      desiredContent: null,
      intent: "delete",
    });
    if (!entry || !onStartApply) throw new Error(t("config.planRouteUnavailable"));
    onStartApply(entry);
    setShowDelete(false);
    toast(t("config.planCreated"));
  };

  const createSnapshot = async () => {
    if (isLocalSnapshot || items.length === 0 || snapshotSaving) return;
    const namespace = tenant || "public";
    const taskName = t("config.snapshotTaskName", { name: connectionName, namespace });
    const taskScope = t("config.taskScope", { name: connectionName, namespace, count: items.length });
    const task = taskManager.createTask(taskName, "backup", { scope: taskScope, cancellable: false });
    taskManager.startTask(task.id);
    setSnapshotSaving(true);

    let completed = 0;
    let failed = 0;
    let lastError = "";
    const configs: {
      dataId: string;
      group: string;
      content: string;
      configType: string;
      updateTime: string;
    }[] = [];

    try {
      for (const item of items) {
        try {
          const itemContent = await getConfig(conn, tenant, item.dataId, item.group);
          configs.push({
            dataId: item.dataId,
            group: item.group,
            content: itemContent,
            configType: item.configType,
            updateTime: item.updateTime ?? "",
          });
          completed += 1;
        } catch (e) {
          failed += 1;
          lastError = errorText(e);
        }
        taskManager.updateProgress(task.id, completed, failed, items.length);
      }

      if (configs.length === 0) {
        throw new Error(lastError || t("config.snapshotNoConfigs"));
      }

      const snapshot = await createSnapshotFromConfigs(conn.id, connectionName, namespace, tenant, configs, effectiveProvider(conn));
      recordOperation({
        type: "snapshot",
        result: "success",
        connectionId: conn.id,
        connectionName,
        namespace,
        group: "*",
        dataId: "*",
        resourceId: snapshot.id,
        resourceName: snapshot.name || snapshot.id,
        rollbackable: false,
        rollbackReason: "operationHistory.rollbackSnapshotOnly",
      });
      const partialError = failed > 0 ? t("config.snapshotPartialFailed", { count: failed }) : "";
      taskManager.completeTask(task.id, failed === 0, partialError);
      toast(t("config.snapshotCreated", { name: snapshot.name || snapshot.id }), failed > 0 ? "info" : "success");
    } catch (e) {
      const message = errorText(e);
      recordOperation({
        type: "snapshot",
        result: "failure",
        connectionId: conn.id,
        connectionName,
        namespace,
        group: "*",
        dataId: "*",
        rollbackable: false,
        rollbackReason: "operationHistory.rollbackOnlySuccess",
        error: message,
      });
      taskManager.completeTask(task.id, false, message);
      reportError({
        title: t("config.snapshotCreateFailed"),
        source: sourceLabel,
        message,
        detail: message,
        actionLabel: t("common.retry"),
        onAction: () => createSnapshot(),
      });
    } finally {
      setSnapshotSaving(false);
    }
  };

  const exportCurrentList = () => {
    // 本函数是同步的，连点两次得到两份文件属正常语义；这里只挡与异步源文件导出交错写同一批配置
    if (sourceExporting) return;
    const taskName = t("config.exportTaskName", { name: connectionName, namespace: namespaceLabel });
    const taskScope = t("config.taskScope", { name: connectionName, namespace: namespaceLabel, count: items.length });
    const task = taskManager.createTask(taskName, "export", { scope: taskScope, cancellable: false });
    taskManager.startTask(task.id);
    const opts: ConfigExportOptions = { format: "json", sensitive: false, includeMeta: true };
    try {
      exportConfigs(
        items.map((it) => ({
          dataId: it.dataId,
          group: it.group,
          content: it.content,
          configType: it.configType,
          namespace: tenant,
          namespaceId: tenant,
          updateTime: it.updateTime ?? "",
        })),
        opts
      );
      taskManager.updateProgress(task.id, items.length, 0, items.length);
      taskManager.completeTask(task.id, true);
      recordOperation({
        type: "export",
        result: "success",
        connectionId: conn.id,
        connectionName,
        namespace: namespaceLabel,
        group: "*",
        dataId: "*",
        resourceName: t("config.exportCurrentList"),
        rollbackable: false,
        rollbackReason: "operationHistory.rollbackExportOnly",
      });
      toast(t("config.exportedCurrentList"), "success");
    } catch (e) {
      const message = errorText(e);
      taskManager.updateProgress(task.id, 0, 1, items.length || 1);
      taskManager.completeTask(task.id, false, message);
      recordOperation({
        type: "export",
        result: "failure",
        connectionId: conn.id,
        connectionName,
        namespace: namespaceLabel,
        group: "*",
        dataId: "*",
        resourceName: t("config.exportCurrentList"),
        rollbackable: false,
        rollbackReason: "operationHistory.rollbackOnlySuccess",
        error: message,
      });
      reportError({
        title: t("config.exportCurrentList"),
        source: sourceLabel,
        message,
        detail: message,
      });
    }
  };

  const exportSourceFilesToDirectory = async () => {
    // 原生目录对话框是异步的：没有这道闸，连点会叠开第二个对话框，
    // 两个导出任务再往同一目录交错写同一批文件
    if (sourceExporting) return;
    setSourceExporting(true);
    try {
      await runExportSourceFilesToDirectory();
    } finally {
      setSourceExporting(false);
    }
  };

  const runExportSourceFilesToDirectory = async () => {
    let targetDir = "";
    try {
      targetDir = await selectConfigSourceExportDirectory();
      if (!targetDir) return;
    } catch (e) {
      const message = errorText(e);
      reportError({
        title: t("config.exportSourceFilesToDirectory"),
        source: sourceLabel,
        message,
        detail: message,
      });
      return;
    }

    const taskName = t("config.exportSourceFilesTaskName", { name: connectionName, namespace: namespaceLabel });
    const taskScope = t("config.taskScope", { name: connectionName, namespace: namespaceLabel, count: items.length });
    const task = taskManager.createTask(taskName, "export", { scope: taskScope, cancellable: false });
    taskManager.startTask(task.id);
    try {
      await exportConfigSourceFiles(
        targetDir,
        {
          provider: conn.sourceType === "local-snapshot" ? "local" : (conn.provider ?? "nacos"),
          connectionId: conn.id,
          connectionName,
          namespace: tenant,
          namespaceId: tenant,
        },
        items.map((it) => ({
          namespace: tenant,
          dataId: it.dataId,
          group: it.group,
          content: it.content,
          configType: it.configType,
          contentType: it.configType,
          updateTime: it.updateTime ?? "",
        }))
      );
      taskManager.updateProgress(task.id, items.length, 0, items.length);
      taskManager.completeTask(task.id, true);
      recordOperation({
        type: "export",
        result: "success",
        connectionId: conn.id,
        connectionName,
        namespace: namespaceLabel,
        group: "*",
        dataId: "*",
        resourceName: t("config.exportSourceFilesToDirectory"),
        rollbackable: false,
        rollbackReason: "operationHistory.rollbackExportOnly",
      });
      toast(t("config.exportedSourceFiles", { path: targetDir }), "success");
    } catch (e) {
      const message = errorText(e);
      taskManager.updateProgress(task.id, 0, 1, items.length || 1);
      taskManager.completeTask(task.id, false, message);
      recordOperation({
        type: "export",
        result: "failure",
        connectionId: conn.id,
        connectionName,
        namespace: namespaceLabel,
        group: "*",
        dataId: "*",
        resourceName: t("config.exportSourceFilesToDirectory"),
        rollbackable: false,
        rollbackReason: "operationHistory.rollbackOnlySuccess",
        error: message,
      });
      reportError({
        title: t("config.exportSourceFilesToDirectory"),
        source: sourceLabel,
        message,
        detail: message,
      });
    }
  };

  return (
    <div className="browser" ref={browserRootRef}>
      <div className="browser-list">
        <div className="browser-search">
          <div className="browser-search-mode" role="group" aria-label={t("config.searchMode")}>
            <button
              type="button"
              className={`btn btn-ghost btn-sm${searchMode === "dataId" ? " active" : ""}`}
              onClick={() => switchSearchMode("dataId")}
            >
              {t("config.searchByDataId")}
            </button>
            <button
              type="button"
              className={`btn btn-ghost btn-sm${searchMode === "content" ? " active" : ""}`}
              onClick={() => switchSearchMode("content")}
            >
              {t("config.searchByContent")}
            </button>
          </div>
          <div className="browser-search-row">
            <input
              type="text"
              className="search-input wide"
              placeholder={searchMode === "content" ? t("config.contentSearchPlaceholder") : t("config.searchPlaceholder")}
              aria-label={searchMode === "content" ? t("config.contentSearchAriaLabel") : t("config.searchAriaLabel")}
              value={search}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => onSearchChange(e.target.value)}
              onCompositionStart={deferredSearch.onCompositionStart}
              onCompositionEnd={(e) => deferredSearch.onCompositionEnd(e.currentTarget.value)}
              onKeyDown={(e) => {
                // 输入法组合态：回车/方向键都属于候选词操作，不能当成「提交搜索 / 移动选中行」
                if (isImeComposing(e)) return;
                if (e.key === "Enter") searchNow();
                else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  moveSelection(1);
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  moveSelection(-1);
                }
              }}
            />
            {/*
              * 刷新按钮不做 disabled。轮43 起它同时是「写后失效」的重取出口，
              * 取数层自己已经会抢占：fetchList / searchAllContent 各自记 req-id，
              * 旧请求回来发现编号不是自己的就丢弃，连点不会把旧数据盖到新数据上。
              * 而 disabled 的原生按钮上 Blink 连 title 都不弹（轮26 F-1 实测取证），
              * 这颗图标按钮的名字只有 title / aria-label 一条渠道，
              * 挂 disabled 换来的只是「忙时悬停没提示」，等于把提示写成了哑巴。
              */}
            <button
              className="btn btn-ghost btn-sm browser-icon-btn"
              onClick={() => {
                void reloadList();
              }}
              title={t("config.refresh")}
              aria-label={t("config.refresh")}
            >
              <BrowserToolIcon name="refresh" />
            </button>
            {canWrite && (
              <button
                className="btn btn-primary btn-sm browser-icon-btn"
                onClick={() => setShowNew(true)}
                title={t("config.newConfig")}
                aria-label={t("config.newConfig")}
              >
                <BrowserToolIcon name="add" />
              </button>
            )}
          </div>
          <div className="browser-action-row">
            <div className="browse-scope-field" title={t("config.groupFilter")}>
              <span>{t("config.groupFilter")}</span>
              <Select
                className="browser-group-select"
                value={selectedGroup}
                options={groupOptions}
                onChange={onGroupChange}
              />
            </div>
            {items.length > 0 && (
              <button
                className="btn btn-ghost btn-sm browser-icon-btn"
                title={
                  sourceExporting
                    ? t("config.exportInFlight")
                    : t("config.exportCurrentList")
                }
                aria-label={
                  sourceExporting
                    ? t("config.exportInFlight")
                    : t("config.exportCurrentList")
                }
                disabled={sourceExporting}
                onClick={exportCurrentList}
              >
                <BrowserToolIcon name="download" />
              </button>
            )}
            {items.length > 0 && (
              <button
                className="btn btn-ghost btn-sm browser-icon-btn"
                title={
                  sourceExporting
                    ? t("config.exportInFlight")
                    : t("config.exportSourceFilesToDirectory")
                }
                aria-label={
                  sourceExporting
                    ? t("config.exportInFlight")
                    : t("config.exportSourceFilesToDirectory")
                }
                disabled={sourceExporting}
                onClick={exportSourceFilesToDirectory}
              >
                <BrowserToolIcon name="download" />
              </button>
            )}
            {!isLocalSnapshot && items.length > 0 && (
              <button
                className="btn btn-ghost btn-sm snapshot-action-btn"
                onClick={createSnapshot}
                disabled={snapshotSaving || listLoading}
                title={snapshotSaving ? t("config.creatingSnapshot") : t("config.createSnapshot")}
              >
                {snapshotSaving ? t("config.creatingSnapshot") : t("config.createSnapshot")}
              </button>
            )}
            {isContentSearchActive && contentResults.length > 0 && canStartReplacement && (
              <button className="btn btn-primary btn-sm browser-replace-btn" type="button" onClick={openReplacePanel}>
                {t("config.batchReplace")}
              </button>
            )}
          </div>
        </div>
        <div className="browser-count">
          {isContentSearchActive ? t("config.contentSearchCount", { count: contentResults.length }) : t("config.total", { count: total })}
        </div>
        {isContentSearchActive && (
          <div className="browser-content-search-status">
            {/* 进度宿主只是语义钩子，不挂 class：外观完全沿用 .browser-content-search-status */}
            <div
              role="progressbar"
              aria-label={t("config.contentSearchProgressBar")}
              aria-valuemin={0}
              aria-valuemax={contentSearchProgress.total || 1}
              aria-valuenow={contentSearchProgress.loaded}
              aria-valuetext={t("config.contentSearchProgress", {
                loaded: contentSearchProgress.loaded,
                total: contentSearchProgress.total,
              })}
            >
              {t("config.contentSearchProgress", { loaded: contentSearchProgress.loaded, total: contentSearchProgress.total })}
            </div>
            {contentSearchProgress.failed > 0 && (
              <span>{t("config.contentSearchPartialFailed", { count: contentSearchProgress.failed })}</span>
            )}
          </div>
        )}
        <div className="browser-items" ref={itemsScrollRef} {...busyProps(listLoading || contentSearching)}>
          {listLoading && (
            <div className="pad-msg" role="status" aria-live="polite">
              {t("config.loading")}
            </div>
          )}
          {listError && <InlineError message={listError} onRetry={() => fetchList(appliedTerm, pageNo, selectedGroup)} />}
          {isContentSearchActive && contentSearchError && (
            <InlineError message={contentSearchError} onRetry={() => searchAllContent(contentTerm, selectedGroup)} />
          )}
          {!listLoading && !listError && !contentSearchError && !contentSearching && visibleItems.length === 0 && (
            <div className="pad-msg browser-empty">
              {/* 搜不出来 ≠ 这个分组本来就空。两者共用一句「没有配置」，用户会去怀疑同步坏了。 */}
              <span>
                {isContentSearchActive
                  ? t("config.contentSearchEmpty", { term: contentTerm })
                  : appliedTerm
                    ? t("config.searchEmpty", { term: appliedTerm })
                    : t("config.empty")}
              </span>
              {(isContentSearchActive || appliedTerm) && (
                <button className="btn btn-ghost btn-sm" type="button" onClick={clearSearchTerms}>
                  {t("config.clearSearch")}
                </button>
              )}
            </div>
          )}
          {/* listbox 只包列表项：加载/报错/空态这些提示留在外面，免得被读成「列表里少了这一项」。
             容器本身 display:contents，不产生盒子，滚动与分隔线仍归 .browser-items。 */}
          <div className="browser-items-list" role="listbox" aria-label={t("config.listAriaLabel")} onKeyDown={onListKeyDown}>
            {visibleItems.map((it) => {
              const key = listItemKey(it);
              const active = selected?.dataId === it.dataId && selected?.group === it.group;
              const result = isContentSearchActive
                ? contentResults.find((candidate) => configResultKey(candidate.item) === configResultKey(it))
                : null;
              return (
                <div
                  key={key}
                  ref={bindItemRef(key)}
                  role="option"
                  aria-selected={active}
                  tabIndex={rovingItemKey === key ? 0 : -1}
                  onFocus={() => setFocusedItemKey(key)}
                  className={`browser-item${active ? " active" : ""}`}
                  onClick={() => guardNav(() => openConfig(it))}
                  title={`${it.dataId}\nGROUP: ${it.group}`}
                >
                  <div className="browser-item-id">{it.dataId}</div>
                  <div className="browser-item-group">
                    {it.group}
                    {it.configType ? ` · ${it.configType}` : ""}
                  </div>
                  {result && (
                    <>
                      <label className="browser-result-check" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedContentKeys.has(configResultKey(it))}
                          onChange={() => toggleContentResult(result)}
                        />
                        <span>{t("config.selectForReplace")}</span>
                      </label>
                      <div
                        className="browser-item-summary"
                        title={result.summary}
                        dangerouslySetInnerHTML={{ __html: highlightSearchTerm(result.summary, contentTerm) }}
                      />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {!isContentSearchActive && (
          <Pager page={pageNo} pages={pages} loading={listLoading} onPage={(p) => fetchList(appliedTerm, p, selectedGroup)} />
        )}
      </div>

      <div className="browser-detail">
        {!selected ? (
          removedByPlan ? (
            <div className="pad-msg big browser-detail-notice" {...statusMessageProps("info")}>
              <div>{t("config.removedByPlan", { dataId: removedByPlan.dataId, group: removedByPlan.group })}</div>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  void reloadList();
                }}
              >
                {t("config.refresh")}
              </button>
            </div>
          ) : (
            <div className="pad-msg big">{t("config.selectHint")}</div>
          )
        ) : (
          <>
            <div className="detail-header">
              <div className="detail-title">
                <span className="detail-dataid mono">{selected.dataId}</span>
                <span className="detail-group">
                  {t("config.group")}: {selected.group}
                  {selected.configType ? ` · ${selected.configType}` : ""}
                </span>
              </div>
              <div className="detail-tabs">
                <button className={`tab-btn${tab === "content" ? " active" : ""}`} onClick={() => setTab("content")}>
                  {t("config.content")}
                </button>
                {canBrowseHistory && (
                  <button className={`tab-btn${tab === "history" ? " active" : ""}`} onClick={() => setTab("history")}>
                    {t("config.history")}
                  </button>
                )}
              </div>
            </div>

            {/* 能力收口后还要防一头：连接在设置里被改成 Apollo 时 tab 状态可能还停在 history，
                正文面板必须落回 content，不能隔着隐藏 tab 渲染 HistoryView（轮55 R55-E2）。 */}
            {tab === "content" || !canBrowseHistory ? (
              <div className="content-box" {...busyProps(contentLoading)}>
                {contentLoading && (
                  <div className="pad-msg" role="status" aria-live="polite">
                    {t("config.loading")}
                  </div>
                )}
                {contentError && selected && <InlineError message={contentError} onRetry={() => openConfig(selected)} />}
                {!contentLoading && !contentError && editing && (
                  <>
                    <div className="fmt-bar">
                      <span className="fmt-label">{t("config.editFormat")}</span>
                      <Select
                        className="fmt-select"
                        value={fmt}
                        options={FORMATS.map((f) => ({ value: f, label: f }))}
                        onChange={(v) => setFmt(v as Format)}
                      />
                      <span className="fmt-write-hint" title={t("config.directWriteDisabledHint")}>
                        {t("config.directWriteDisabledHint")}
                      </span>
                      {saveError && <InlineError message={saveError} />}
                      <span className="fmt-spacer" />
                      <button className="btn btn-ghost btn-sm" onClick={cancelEditing}>
                        {t("common.cancel")}
                      </button>
                      <button className="btn btn-primary btn-sm" onClick={saveAsPlan} title={t("config.saveShortcutHint")}>
                        {t("config.saveAsPlan")}
                      </button>
                    </div>
                    <div className="editor-host grow">
                      <CodeEditor
                        ref={editorRef}
                        value={draft}
                        onChange={setDraft}
                        format={fmt}
                        ariaLabel={t("config.contentLabel")}
                        active={active}
                        searchTerm={isContentSearchActive ? contentTerm : undefined}
                        onSave={saveAsPlan}
                      />
                    </div>
                  </>
                )}
                {!contentLoading && !contentError && !editing && (
                  <>
                    <div className="fmt-bar">
                      <span className="fmt-label">{t("config.format")}</span>
                      <Select
                        className="fmt-select"
                        value={fmt}
                        options={FORMATS.map((f) => ({ value: f, label: f }))}
                        onChange={(v) => setFmt(v as Format)}
                      />
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => selected && openConfig(selected)}
                        title={t("config.refreshContent")}
                        aria-label={t("config.refreshContent")}
                        disabled={contentLoading}
                      >
                        ⟳
                      </button>
                      <CopyButton text={content} />
                      <span className="fmt-spacer" />
                      {canWrite && (
                        <>
                          <button className="btn btn-ghost btn-sm" onClick={startEdit} disabled={contentLoading}>
                            {t("common.edit")}
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setShowDelete(true)} disabled={contentLoading}>
                            {t("common.delete")}
                          </button>
                        </>
                      )}
                    </div>
                    {metadataItems.length > 0 && (
                      <div className="config-meta-row">
                        {metadataItems.map((item) => (
                          <div className="config-meta-item" key={item.label}>
                            <span className="config-meta-label">{item.label}</span>
                            <span className="config-meta-value" title={item.value}>
                              {item.value}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <CodeView code={content} format={fmt} searchTerm={isContentSearchActive ? contentTerm : undefined} active={active} />
                  </>
                )}
              </div>
            ) : (
              <ConfigHistoryPanel
                conn={conn}
                tenant={tenant}
                active={active}
                dataId={selected.dataId}
                group={selected.group}
                currentContent={content}
                format={fmt}
                searchTerm={isContentSearchActive ? contentTerm : undefined}
                onStartApply={onStartApply}
              />
            )}
          </>
        )}
      </div>

      {showNew && (
        <ConfigEditor
          conn={conn}
          namespace={tenant}
          active={active}
          onStartApply={onStartApply}
          onClose={() => setShowNew(false)}
        />
      )}

      {showDelete && selected && (
        <DeleteConfirm
          name={selected.dataId}
          group={selected.group}
          onCancel={() => setShowDelete(false)}
          onConfirm={deleteAsPlan}
          confirmLabel={t("config.deleteAsPlan")}
          busyLabel={t("config.generatingPlan")}
          failureTitle={t("config.planFailed")}
          retryLabel={t("common.retry")}
        />
      )}

      {showReplace && (
        <div className="modal-overlay" {...replaceOverlayDismiss}>
          <div
            ref={replaceModalRef}
            className="modal modal-md browser-replace-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={replaceTitleId}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id={replaceTitleId}>{t("config.batchReplace")}</h3>
              <button
                className="modal-x"
                type="button"
                title={t("common.close")}
                aria-label={t("common.close")}
                onClick={() => setShowReplace(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="browser-replace-summary">
                <strong>{t("config.replaceSelection", { count: selectedContentResults.length })}</strong>
                <span>{t("config.replaceImpact", { configs: replaceImpact.configs, replacements: replaceImpact.replacements })}</span>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="config-replace-find">
                  {t("config.findText")}
                </label>
                <input
                  type="text"
                  id="config-replace-find"
                  className="search-input wide mono"
                  value={replaceFindText}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => setReplaceFindText(event.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="config-replace-text">
                  {t("config.replaceText")}
                </label>
                <input
                  type="text"
                  id="config-replace-text"
                  className="search-input wide mono"
                  value={replaceText}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => setReplaceText(event.target.value)}
                />
                <div className="field-hint">{t("config.replaceLiteralHint")}</div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" type="button" onClick={() => setShowReplace(false)}>
                {t("common.cancel")}
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={!replaceFindText || replaceImpact.configs === 0}
                onClick={openTargetPicker}
              >
                {t("config.chooseApplyTarget")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showTargetPicker && (
        <div className="modal-overlay" {...targetOverlayDismiss}>
          <div
            ref={targetModalRef}
            className="modal modal-md browser-target-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={targetTitleId}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3 id={targetTitleId}>{t("config.applyToTarget")}</h3>
              <button
                className="modal-x"
                type="button"
                title={t("common.close")}
                aria-label={t("common.close")}
                onClick={() => setShowTargetPicker(false)}
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="browser-target-flow">
                <div className="browser-target-scope">
                  <span>{t("config.applySource")}</span>
                  <strong title={sourceEndpoint.label}>{sourceEndpoint.label}</strong>
                </div>
                <span className="browser-target-arrow" aria-hidden="true">
                  →
                </span>
                <div className="browser-target-scope">
                  <span>{t("config.applyTarget")}</span>
                  <strong title={targetConnection ? connectionLabel(targetConnection, t) : t("config.noApplyTarget")}>
                    {targetConnection ? connectionLabel(targetConnection, t) : t("config.noApplyTarget")}
                  </strong>
                </div>
              </div>
              <div className="field">
                <label className="field-label">{t("config.targetEnvironment")}</label>
                <Select
                  value={targetConnectionId}
                  placeholder={t("config.noApplyTarget")}
                  options={targetConnections.map((candidate) => ({
                    value: candidate.id,
                    label: `${connectionLabel(candidate, t)}${
                      candidate.id === conn.id
                        ? ` · ${t("config.sourceDefault")}`
                        : isSandboxEnvironment(candidate)
                          ? ` · ${t("config.sandboxDefault")}`
                          : ""
                    }`,
                  }))}
                  onChange={setTargetConnectionId}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="config-target-namespace">
                  {t("config.targetNamespace")}
                </label>
                <input
                  type="text"
                  id="config-target-namespace"
                  className="search-input wide mono"
                  spellCheck={false}
                  value={targetNamespace}
                  placeholder={t("app.namespaceDefault")}
                  onChange={(event) => setTargetNamespace(event.target.value)}
                />
              </div>
              <div className="field-hint browser-target-notice">{t("config.applyPlanRequired")}</div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" type="button" onClick={() => setShowTargetPicker(false)}>
                {t("common.cancel")}
              </button>
              <button className="btn btn-primary" type="button" disabled={!targetConnection} onClick={startContentReplaceApply}>
                {t("config.generateApplyPlan", { count: replaceImpact.configs })}
              </button>
            </div>
          </div>
        </div>
      )}

      {pending && (
        <ConfirmModal
          title={t("config.discardConfirm")}
          message={t(pendingSwitches ? "config.discardSwitchMessage" : "config.discardCancelMessage")}
          confirmLabel={t(pendingSwitches ? "config.discardAndSwitch" : "config.discardChanges")}
          cancelLabel={t(pendingSwitches ? "config.stayCurrent" : "config.stayEditing")}
          danger
          onConfirm={() => {
            const act = pending;
            setPending(null);
            setEditing(false);
            act();
          }}
          onCancel={() => setPending(null)}
          active={active}
        />
      )}

      {validateErrs.length > 0 && (
        <AlertModal
          title={t("config.validateFailed")}
          messages={validateErrs}
          onClose={() => setValidateErrs([])}
          active={active}
          onJumpToLine={(line) => {
            // 先关弹框再跳：弹框还开着就把焦点抢回编辑器，用户看不到落点
            setValidateErrs([]);
            editorRef.current?.revealLine(line);
          }}
        />
      )}
    </div>
  );
}

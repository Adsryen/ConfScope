import { useEffect, useMemo, useRef, useState } from "react";
import { Connection, connectionDisplayLabel, connectionProjectName } from "../store/connections";
import { ConfigItem, getConfig, getConfigDocument, listConfigs, type ConfigDocument } from "../api/nacos";
import type { ApplyEntryEndpoint, ApplyEntryPayload } from "../lib/applyEntry";
import {
  buildContentReplaceApplyEntry,
  replacementImpact,
  highlightSearchTerm,
  searchConfigContent,
  type ContentSearchResult,
} from "../lib/configContentSearch";
import { detectFormat, Format, FORMATS, nacosType } from "../lib/format";
import { reportError } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import { validateConfig } from "../lib/validate";
import { useTranslation } from "../i18n";
import { exportConfigs, type ConfigExportOptions } from "../lib/export";
import { createSnapshotFromConfigs } from "../api/snapshot";
import { exportConfigSourceFiles, selectConfigSourceExportDirectory } from "../api/app";
import { useTaskManager } from "../lib/taskmanager";
import { recordOperation } from "../store/operationHistory";
import AlertModal from "./AlertModal";
import CodeEditor from "./CodeEditor";
import ConfirmModal from "./ConfirmModal";
import CodeView from "./CodeView";
import ConfigEditor from "./ConfigEditor";
import CopyButton from "./CopyButton";
import DeleteConfirm from "./DeleteConfirm";
import HistoryView from "./HistoryView";
import Pager from "./Pager";
import Select from "./Select";

interface Props {
  conn: Connection;
  tenant: string;
  connections?: Connection[];
  onStartApply?: (payload: ApplyEntryPayload) => void;
}

const PAGE_SIZE = 50;
const CONTENT_SEARCH_CONCURRENCY = 6;
type Tab = "content" | "history";
type SearchMode = "dataId" | "content";
type ConfigMetadata = Pick<ConfigDocument, "version" | "source" | "updateTime">;
type InlineErrorProps = {
  title: string;
  message: string;
  retryLabel: string;
  copyLabel: string;
  onRetry?: () => void;
};

function InlineError({ title, message, retryLabel, copyLabel, onRetry }: InlineErrorProps) {
  return (
    <div className="inline-error" role="alert">
      <div className="inline-error-head">
        <span className="inline-error-title">{title}</span>
        <div className="inline-error-actions">
          {onRetry && (
            <button className="btn btn-ghost btn-sm" onClick={onRetry}>
              {retryLabel}
            </button>
          )}
          <CopyButton text={message} label={copyLabel} />
        </div>
      </div>
      <pre className="inline-error-body">{message}</pre>
    </div>
  );
}

function configResultKey(item: Pick<ConfigItem, "dataId" | "group">): string {
  return `${item.group}\u0000${item.dataId}`;
}

function isWritableTarget(conn: Connection): boolean {
  return conn.sourceType !== "local-snapshot" && !conn.readonly && (conn.provider ?? "nacos") === "nacos";
}

function isSandboxEnvironment(conn: Connection): boolean {
  return /sandbox|沙箱/i.test(`${conn.name} ${conn.environmentName ?? ""} ${conn.sourceName ?? ""} ${(conn.tags ?? []).join(" ")}`);
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
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
export default function ConfigBrowser({ conn, tenant, connections = [], onStartApply }: Props) {
  const { t } = useTranslation();
  const taskManager = useTaskManager();
  const [search, setSearch] = useState("");
  const [searchMode, setSearchMode] = useState<SearchMode>("dataId");
  const [appliedTerm, setAppliedTerm] = useState(""); // 已生效的搜索词（翻页时复用）
  const [contentTerm, setContentTerm] = useState("");
  const [contentResults, setContentResults] = useState<ContentSearchResult[]>([]);
  const [contentSearchProgress, setContentSearchProgress] = useState({ loaded: 0, total: 0, failed: 0 });
  const [contentSearchError, setContentSearchError] = useState<string | null>(null);
  const [selectedContentKeys, setSelectedContentKeys] = useState<Set<string>>(new Set());
  const [showReplace, setShowReplace] = useState(false);
  const [showTargetPicker, setShowTargetPicker] = useState(false);
  const [replaceFindText, setReplaceFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [targetConnectionId, setTargetConnectionId] = useState("");
  const [targetNamespace, setTargetNamespace] = useState(tenant);
  const [selectedGroup, setSelectedGroup] = useState("");
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [snapshotSaving, setSnapshotSaving] = useState(false);
  // 编辑中有未保存改动时,切换配置先确认;pending 保存待执行的跳转动作
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [validateErrs, setValidateErrs] = useState<string[]>([]);
  const dirty = editing && draft !== content;
  const isLocalSnapshot = conn.sourceType === "local-snapshot";
  const isContentSearchActive = searchMode === "content" && Boolean(contentTerm);
  const visibleItems = isContentSearchActive ? contentResults.map((result) => result.item) : items;
  const selectedContentResults = contentResults.filter((result) => selectedContentKeys.has(configResultKey(result.item)));
  const replaceImpact = replacementImpact(selectedContentResults, replaceFindText, replaceText);
  const canStartReplacement = Boolean(onStartApply) && isWritableTarget(conn);
  const connectionName = conn.name || connectionDisplayLabel(conn);
  const namespaceLabel = tenant || "public";
  const sourceLabel = `${connectionName} / ${namespaceLabel}`;
  const targetConnections = useMemo(
    () =>
      connections
        .filter(
          (candidate) =>
            connectionProjectName(candidate) === connectionProjectName(conn) && candidate.id !== conn.id && isWritableTarget(candidate)
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
    label: `${connectionDisplayLabel(conn)} / ${namespaceLabel}`,
  };
  const inlineErrorLabels = {
    title: t("common.operationFailed"),
    retryLabel: t("common.retry"),
    copyLabel: t("common.copyError"),
  };
  const metadataItems =
    isLocalSnapshot && metadata
      ? [
          { label: t("config.updateTime"), value: metadata.updateTime },
          { label: t("config.version"), value: metadata.version },
          { label: t("config.source"), value: metadata.source },
        ].filter((item) => item.value)
      : [];
  const guardNav = (action: () => void) => {
    if (dirty) setPending(() => action);
    else action();
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
    setContentTerm("");
    setContentResults([]);
    setContentSearchProgress({ loaded: 0, total: 0, failed: 0 });
    setContentSearchError(null);
    setSelectedContentKeys(new Set());
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
    setContentTerm(query);
    setContentResults([]);
    setContentSearchProgress({ loaded: 0, total: 0, failed: 0 });
    setContentSearchError(null);
    setSelectedContentKeys(new Set());
    try {
      const firstPage = await listConfigs(conn, tenant, "", group, 1, PAGE_SIZE);
      if (my !== contentSearchReqId.current) return;
      const allItems = [...firstPage.pageItems];
      const pageCount = Math.max(firstPage.pagesAvailable || 1, 1);
      for (let page = 2; page <= pageCount; page += 1) {
        const nextPage = await listConfigs(conn, tenant, "", group, page, PAGE_SIZE);
        if (my !== contentSearchReqId.current) return;
        allItems.push(...nextPage.pageItems);
      }
      setContentSearchProgress({ loaded: 0, total: allItems.length, failed: 0 });

      const loaded = await mapWithConcurrency(allItems, CONTENT_SEARCH_CONCURRENCY, async (item) => {
        try {
          const document = await getConfigDocument(conn, tenant, item.dataId, item.group);
          return { item, document, error: "" };
        } catch (error) {
          return { item, document: null, error: String(error) };
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
      setSelectedContentKeys(new Set(results.map((result) => configResultKey(result.item))));
      setContentSearchProgress({ loaded: allItems.length, total: allItems.length, failed: failures.length });
      if (failures.length) {
        setContentSearchError(failures.map((result) => `${result.item.group}/${result.item.dataId}: ${result.error}`).join("\n"));
      }
    } catch (error) {
      if (my !== contentSearchReqId.current) return;
      const message = String(error);
      setContentSearchError(message);
      reportError({
        title: t("config.contentSearchFailed"),
        source: sourceLabel,
        message,
        detail: message,
        actionLabel: t("common.retry"),
        onAction: () => searchAllContent(query, group),
      });
    }
  };

  const fetchList = async (term: string, page: number, groupFilter = selectedGroup) => {
    const my = ++listReqId.current;
    const group = groupFilter.trim();
    setListLoading(true);
    setListError(null);
    setAppliedTerm(term);
    setPageNo(page);
    try {
      // blur 搜索：用 *term* 模糊匹配 dataId；term 为空则列全部
      const dataId = term.trim() ? `*${term.trim()}*` : "";
      const res = await listConfigs(conn, tenant, dataId, group, page, PAGE_SIZE);
      if (my !== listReqId.current) return;
      setItems(res.pageItems);
      rememberGroups(res.pageItems, group);
      setTotal(res.totalCount);
      setPages(Math.max(res.pagesAvailable || 1, 1));
    } catch (e) {
      if (my !== listReqId.current) return;
      const message = String(e);
      setListError(message);
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

  // 输入即搜:防抖自动搜索(无需「搜索」按钮)
  const searchTimer = useRef<number | undefined>(undefined);
  const onSearchChange = (v: string) => {
    setSearch(v);
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      if (searchMode === "content") searchAllContent(v, selectedGroup);
      else fetchList(v, 1, selectedGroup);
    }, 400);
  };
  const searchNow = () => {
    window.clearTimeout(searchTimer.current);
    if (searchMode === "content") searchAllContent(search, selectedGroup);
    else fetchList(search, 1, selectedGroup);
  };
  const switchSearchMode = (mode: SearchMode) => {
    if (mode === searchMode) return;
    window.clearTimeout(searchTimer.current);
    setSearchMode(mode);
    if (mode === "content") searchAllContent(search, selectedGroup);
    else {
      clearContentSearch();
      fetchList(search, 1, selectedGroup);
    }
  };
  useEffect(() => () => window.clearTimeout(searchTimer.current), []);
  const onGroupChange = (group: string) => {
    guardNav(() => {
      window.clearTimeout(searchTimer.current);
      setSelectedGroup(group);
      setSelected(null);
      setContent("");
      setMetadata(null);
      setTab("content");
      if (searchMode === "content") searchAllContent(search, group);
      else fetchList(search, 1, group);
    });
  };

  // 键盘上下键在列表中移动选中(从搜索框或列表触发)
  const moveSelection = (delta: number) => {
    if (!items.length) return;
    const idx = items.findIndex((it) => selected && it.dataId === selected.dataId && it.group === selected.group);
    const next = idx < 0 ? (delta > 0 ? 0 : items.length - 1) : idx + delta;
    const it = items[Math.min(Math.max(next, 0), items.length - 1)];
    if (it) guardNav(() => openConfig(it));
  };
  // 选中项滚入可视区
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected?.dataId, selected?.group]);

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
    setSelectedGroup("");
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
    fetchList("", 1, "");
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
      const message = String(e);
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
    const targetLabel = `${connectionDisplayLabel(targetConnection)} / ${targetNamespace || "public"}`;
    const entry = buildContentReplaceApplyEntry({
      source: sourceEndpoint,
      target: {
        provider: targetConnection.provider ?? "nacos",
        connectionId: targetConnection.id,
        connectionName: targetConnection.name || connectionDisplayLabel(targetConnection),
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

  const saveEdit = async () => {
    if (!selected) return;
    const problems = validateConfig(draft, fmt);
    if (problems.length) {
      setValidateErrs(problems); // 弹框提示并禁止保存
      return;
    }
    setSaving(true);
    setSaveError(null);
    const configType = nacosType(fmt);
    const message = t("api.directWriteRequiresApplyPlan");
    recordOperation({
      type: "publish",
      result: "failure",
      connectionId: conn.id,
      connectionName,
      namespace: namespaceLabel,
      group: selected.group,
      dataId: selected.dataId,
      content: draft,
      previousContent: content,
      beforeContent: content,
      afterContent: draft,
      configType,
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackOnlySuccess",
      error: message,
    });
    setSaveError(message);
    reportError({
      title: t("config.publishConfigFailed"),
      source: `${sourceLabel} / ${selected.group} / ${selected.dataId}`,
      message,
      detail: message,
      actionLabel: t("config.retryPublish"),
      onAction: () => saveEdit(),
    });
    setSaving(false);
  };

  // 编辑态按 Esc 取消编辑(无弹框时)
  useEffect(() => {
    if (!editing || showNew || showDelete || pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditing(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, showNew, showDelete, pending]);

  // 实际删除（由确认弹框调用，失败时抛出供弹框展示）。
  const doDelete = async () => {
    if (!selected) return;
    const message = t("api.directWriteRequiresApplyPlan");
    recordOperation({
      type: "delete",
      result: "failure",
      connectionId: conn.id,
      connectionName,
      namespace: namespaceLabel,
      group: selected.group,
      dataId: selected.dataId,
      previousContent: content,
      beforeContent: content,
      configType: selected.configType || nacosType(fmt),
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackOnlySuccess",
      error: message,
    });
    throw new Error(message);
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
          lastError = String(e);
        }
        taskManager.updateProgress(task.id, completed, failed, items.length);
      }

      if (configs.length === 0) {
        throw new Error(lastError || t("config.snapshotNoConfigs"));
      }

      const snapshot = await createSnapshotFromConfigs(conn.id, connectionName, namespace, tenant, configs);
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
      const message = String(e);
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
      const message = String(e);
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
    let targetDir = "";
    try {
      targetDir = await selectConfigSourceExportDirectory();
      if (!targetDir) return;
    } catch (e) {
      const message = String(e);
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
      const message = String(e);
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
    <div className="browser">
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
              className="search-input wide"
              placeholder={searchMode === "content" ? t("config.contentSearchPlaceholder") : t("config.searchPlaceholder")}
              value={search}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
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
            <button
              className="btn btn-ghost btn-sm browser-icon-btn"
              onClick={() =>
                searchMode === "content" ? searchAllContent(search, selectedGroup) : fetchList(appliedTerm, pageNo, selectedGroup)
              }
              title={t("config.refresh")}
              aria-label={t("config.refresh")}
              disabled={listLoading}
            >
              <BrowserToolIcon name="refresh" />
            </button>
            {!isLocalSnapshot && (
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
            <Select
              className="browser-group-select"
              value={selectedGroup}
              options={groupOptions}
              onChange={onGroupChange}
              title={t("config.groupFilter")}
            />
            {items.length > 0 && (
              <button
                className="btn btn-ghost btn-sm browser-icon-btn"
                title={t("config.exportCurrentList")}
                aria-label={t("config.exportCurrentList")}
                onClick={exportCurrentList}
              >
                <BrowserToolIcon name="download" />
              </button>
            )}
            {items.length > 0 && (
              <button
                className="btn btn-ghost btn-sm browser-icon-btn"
                title={t("config.exportSourceFilesToDirectory")}
                aria-label={t("config.exportSourceFilesToDirectory")}
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
            {t("config.contentSearchProgress", { loaded: contentSearchProgress.loaded, total: contentSearchProgress.total })}
            {contentSearchProgress.failed > 0 && (
              <span>{t("config.contentSearchPartialFailed", { count: contentSearchProgress.failed })}</span>
            )}
          </div>
        )}
        <div className="browser-items">
          {listLoading && <div className="pad-msg">{t("config.loading")}</div>}
          {listError && (
            <InlineError {...inlineErrorLabels} message={listError} onRetry={() => fetchList(appliedTerm, pageNo, selectedGroup)} />
          )}
          {isContentSearchActive && contentSearchError && (
            <InlineError {...inlineErrorLabels} message={contentSearchError} onRetry={() => searchAllContent(contentTerm, selectedGroup)} />
          )}
          {!listLoading && !listError && !contentSearchError && visibleItems.length === 0 && (
            <div className="pad-msg">{t("config.empty")}</div>
          )}
          {visibleItems.map((it) => {
            const active = selected?.dataId === it.dataId && selected?.group === it.group;
            const result = isContentSearchActive
              ? contentResults.find((candidate) => configResultKey(candidate.item) === configResultKey(it))
              : null;
            return (
              <div
                key={`${it.group}/${it.dataId}`}
                ref={active ? activeRef : undefined}
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
                    <div className="browser-item-summary" dangerouslySetInnerHTML={{ __html: highlightSearchTerm(result.summary, contentTerm) }} />
                  </>
                )}
              </div>
            );
          })}
        </div>
        {!isContentSearchActive && (
          <Pager page={pageNo} pages={pages} loading={listLoading} onPage={(p) => fetchList(appliedTerm, p, selectedGroup)} />
        )}
      </div>

      <div className="browser-detail">
        {!selected ? (
          <div className="pad-msg big">{t("config.selectHint")}</div>
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
                {!isLocalSnapshot && (
                  <button className={`tab-btn${tab === "history" ? " active" : ""}`} onClick={() => setTab("history")}>
                    {t("config.history")}
                  </button>
                )}
              </div>
            </div>

            {tab === "content" ? (
              <div className="content-box">
                {contentLoading && <div className="pad-msg">{t("config.loading")}</div>}
                {contentError && selected && (
                  <InlineError {...inlineErrorLabels} message={contentError} onRetry={() => openConfig(selected)} />
                )}
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
                      {saveError && <InlineError {...inlineErrorLabels} message={saveError} onRetry={saveEdit} />}
                      <span className="fmt-spacer" />
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setEditing(false);
                          setSaveError(null);
                        }}
                      >
                        {t("common.cancel")}
                      </button>
                      <button className="btn btn-primary btn-sm" onClick={saveEdit} disabled={saving}>
                        {saving ? t("config.publishing") : t("config.savePublish")}
                      </button>
                    </div>
                    <div className="editor-host grow">
                      <CodeEditor value={draft} onChange={setDraft} format={fmt} />
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
                        disabled={contentLoading}
                      >
                        ⟳
                      </button>
                      <CopyButton text={content} />
                      <span className="fmt-spacer" />
                      {!isLocalSnapshot && (
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
                    <CodeView code={content} format={fmt} searchTerm={isContentSearchActive ? contentTerm : undefined} />
                  </>
                )}
              </div>
            ) : (
              <HistoryView
                conn={conn}
                tenant={tenant}
                dataId={selected.dataId}
                group={selected.group}
                currentContent={content}
                format={fmt}
                onRolledBack={() => selected && openConfig(selected)}
              />
            )}
          </>
        )}
      </div>

      {showNew && (
        <ConfigEditor
          conn={conn}
          namespace={tenant}
          onClose={() => setShowNew(false)}
          onSaved={(dataId, group) => {
            const nextGroup = group.trim() || "DEFAULT_GROUP";
            setShowNew(false);
            setTab("content");
            setSearch("");
            setSelectedGroup(nextGroup);
            rememberGroups([], nextGroup);
            fetchList("", 1, nextGroup);
            openConfig({ dataId, group: nextGroup, content: "", configType: "" });
          }}
        />
      )}

      {showDelete && selected && (
        <DeleteConfirm name={selected.dataId} group={selected.group} onCancel={() => setShowDelete(false)} onConfirm={doDelete} />
      )}

      {showReplace && (
        <div className="modal-overlay" onClick={() => setShowReplace(false)}>
          <div className="modal modal-md browser-replace-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>{t("config.batchReplace")}</h3>
              <button className="modal-x" type="button" title={t("common.close")} onClick={() => setShowReplace(false)}>
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
        <div className="modal-overlay" onClick={() => setShowTargetPicker(false)}>
          <div className="modal modal-md browser-target-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>{t("config.applyToTarget")}</h3>
              <button className="modal-x" type="button" title={t("common.close")} onClick={() => setShowTargetPicker(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="browser-target-flow">
                <div className="browser-target-scope">
                  <span>{t("config.applySource")}</span>
                  <strong>{sourceEndpoint.label}</strong>
                </div>
                <span className="browser-target-arrow" aria-hidden="true">
                  →
                </span>
                <div className="browser-target-scope">
                  <span>{t("config.applyTarget")}</span>
                  <strong>{targetConnection ? connectionDisplayLabel(targetConnection) : t("config.noApplyTarget")}</strong>
                </div>
              </div>
              <div className="field">
                <label className="field-label">{t("config.targetEnvironment")}</label>
                <Select
                  value={targetConnectionId}
                  placeholder={t("config.noApplyTarget")}
                  options={targetConnections.map((candidate) => ({
                    value: candidate.id,
                    label: `${connectionDisplayLabel(candidate)}${isSandboxEnvironment(candidate) ? ` · ${t("config.sandboxDefault")}` : ""}`,
                  }))}
                  onChange={setTargetConnectionId}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="config-target-namespace">
                  {t("config.targetNamespace")}
                </label>
                <input
                  id="config-target-namespace"
                  className="search-input wide mono"
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
          message={t("config.discardMessage")}
          confirmLabel={t("config.discardAndSwitch")}
          cancelLabel={t("config.stayCurrent")}
          danger
          onConfirm={() => {
            const act = pending;
            setPending(null);
            setEditing(false);
            act();
          }}
          onCancel={() => setPending(null)}
        />
      )}

      {validateErrs.length > 0 && (
        <AlertModal title={t("config.validateFailed")} messages={validateErrs} onClose={() => setValidateErrs([])} />
      )}
    </div>
  );
}

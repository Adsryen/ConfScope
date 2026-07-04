import { useEffect, useRef, useState } from "react";
import { Connection, connectionDisplayLabel } from "../store/connections";
import { ConfigItem, deleteConfig, getConfig, listConfigs, publishConfig } from "../api/nacos";
import { detectFormat, Format, FORMATS, nacosType } from "../lib/format";
import { reportError } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import { validateConfig } from "../lib/validate";
import { useTranslation } from "../i18n";
import { exportConfigs, type ConfigExportOptions } from "../lib/export";
import { createSnapshotFromConfigs } from "../api/snapshot";
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
}

const PAGE_SIZE = 50;
type Tab = "content" | "history";
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

/** 配置浏览：左侧 dataId 列表（可搜索、分页），右侧内容 / 历史 标签页。 */
export default function ConfigBrowser({ conn, tenant }: Props) {
  const { t } = useTranslation();
  const taskManager = useTaskManager();
  const [search, setSearch] = useState("");
  const [appliedTerm, setAppliedTerm] = useState(""); // 已生效的搜索词（翻页时复用）
  const [items, setItems] = useState<ConfigItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageNo, setPageNo] = useState(1);
  const [pages, setPages] = useState(1);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selected, setSelected] = useState<ConfigItem | null>(null);
  const [content, setContent] = useState("");
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
  const connectionName = conn.name || connectionDisplayLabel(conn);
  const namespaceLabel = tenant || "public";
  const sourceLabel = `${connectionName} / ${namespaceLabel}`;
  const inlineErrorLabels = {
    title: t("common.operationFailed"),
    retryLabel: t("common.retry"),
    copyLabel: t("common.copyError"),
  };
  const guardNav = (action: () => void) => {
    if (dirty) setPending(() => action);
    else action();
  };

  // 列表请求序号：防止快速搜索/刷新时旧结果覆盖新结果。
  const listReqId = useRef(0);

  const fetchList = async (term: string, page: number) => {
    const my = ++listReqId.current;
    setListLoading(true);
    setListError(null);
    setAppliedTerm(term);
    setPageNo(page);
    try {
      // blur 搜索：用 *term* 模糊匹配 dataId；term 为空则列全部
      const dataId = term.trim() ? `*${term.trim()}*` : "";
      const res = await listConfigs(conn, tenant, dataId, "", page, PAGE_SIZE);
      if (my !== listReqId.current) return;
      setItems(res.pageItems);
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
        onAction: () => fetchList(term, page),
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
    searchTimer.current = window.setTimeout(() => fetchList(v, 1), 400);
  };
  const searchNow = () => {
    window.clearTimeout(searchTimer.current);
    fetchList(search, 1);
  };
  useEffect(() => () => window.clearTimeout(searchTimer.current), []);

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
    setSearch("");
    setSelected(null);
    setContent("");
    fetchList("", 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, tenant]);

  // 每次打开配置自增，异步结果只在仍是最新一次请求时才采用，避免连点串台。
  const reqId = useRef(0);

  const openConfig = async (item: ConfigItem) => {
    const my = ++reqId.current;
    setSelected(item); // 立即高亮，与异步内容加载解耦；切换配置保持当前标签页
    setContentLoading(true);
    setContentError(null);
    setContent("");
    try {
      const text = await getConfig(conn, tenant, item.dataId, item.group);
      if (my !== reqId.current) return; // 已有更晚的点击，丢弃本次结果
      setContent(text);
      setFmt(detectFormat(item.dataId, item.configType, text));
    } catch (e) {
      if (my !== reqId.current) return;
      const message = String(e);
      setContentError(message);
      setContent("");
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

  const saveEdit = async () => {
    if (!selected) return;
    const problems = validateConfig(draft, fmt);
    if (problems.length) {
      setValidateErrs(problems); // 弹框提示并禁止保存
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await publishConfig(conn, tenant, selected.dataId, selected.group, draft, nacosType(fmt));
      recordOperation({
        type: "publish",
        result: "success",
        connectionId: conn.id,
        connectionName,
        namespace: namespaceLabel,
        group: selected.group,
        dataId: selected.dataId,
        content: draft,
        previousContent: content,
        beforeContent: content,
        afterContent: draft,
        configType: nacosType(fmt),
        rollbackable: true,
      });
      setEditing(false);
      toast(t("config.published"));
      await openConfig(selected); // 重新拉取最新内容
    } catch (e) {
      const message = String(e);
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
        configType: nacosType(fmt),
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
    } finally {
      setSaving(false);
    }
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
    try {
      await deleteConfig(conn, tenant, selected.dataId, selected.group);
      recordOperation({
        type: "delete",
        result: "success",
        connectionId: conn.id,
        connectionName,
        namespace: namespaceLabel,
        group: selected.group,
        dataId: selected.dataId,
        previousContent: content,
        beforeContent: content,
        configType: selected.configType || nacosType(fmt),
        rollbackable: true,
      });
      setShowDelete(false);
      setSelected(null);
      setContent("");
      toast(t("config.deleted"));
      fetchList(appliedTerm, pageNo);
    } catch (e) {
      const message = String(e);
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
      throw e;
    }
  };

  const createSnapshot = async () => {
    if (items.length === 0 || snapshotSaving) return;
    const namespace = tenant || "public";
    const taskName = t("config.snapshotTaskName", { name: conn.name || connectionDisplayLabel(conn), namespace });
    const task = taskManager.createTask(taskName, "backup");
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
            updateTime: "",
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

  return (
    <div className="browser">
      <div className="browser-list">
        <div className="browser-search">
          <input
            className="search-input wide"
            placeholder={t("config.searchPlaceholder")}
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
            className="btn btn-ghost btn-sm"
            onClick={() => fetchList(appliedTerm, pageNo)}
            title={t("config.refresh")}
            disabled={listLoading}
          >
            ⟳
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)} title={t("config.newConfig")}>
            ＋
          </button>
          {items.length > 0 && (
            <button
              className="btn btn-ghost btn-sm"
              title={t("config.exportCurrentList")}
              onClick={() => {
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
                      updateTime: "",
                    })),
                    opts
                  );
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
              }}
            >
              ↓
            </button>
          )}
          {items.length > 0 && (
            <button className="btn btn-ghost btn-sm snapshot-action-btn" onClick={createSnapshot} disabled={snapshotSaving || listLoading}>
              {snapshotSaving ? t("config.creatingSnapshot") : t("config.createSnapshot")}
            </button>
          )}
        </div>
        <div className="browser-count">{t("config.total", { count: total })}</div>
        <div className="browser-items">
          {listLoading && <div className="pad-msg">{t("config.loading")}</div>}
          {listError && <InlineError {...inlineErrorLabels} message={listError} onRetry={() => fetchList(appliedTerm, pageNo)} />}
          {!listLoading && !listError && items.length === 0 && <div className="pad-msg">{t("config.empty")}</div>}
          {items.map((it) => {
            const active = selected?.dataId === it.dataId && selected?.group === it.group;
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
              </div>
            );
          })}
        </div>
        <Pager page={pageNo} pages={pages} loading={listLoading} onPage={(p) => fetchList(appliedTerm, p)} />
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
                <button className={`tab-btn${tab === "history" ? " active" : ""}`} onClick={() => setTab("history")}>
                  {t("config.history")}
                </button>
              </div>
            </div>

            {tab === "content" ? (
              <div className="content-box">
                {contentLoading && <div className="pad-msg">{t("config.loading")}</div>}
                {contentError && selected && <InlineError {...inlineErrorLabels} message={contentError} onRetry={() => openConfig(selected)} />}
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
                      <button className="btn btn-ghost btn-sm" onClick={startEdit} disabled={contentLoading}>
                        {t("common.edit")}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setShowDelete(true)} disabled={contentLoading}>
                        {t("common.delete")}
                      </button>
                    </div>
                    <CodeView code={content} format={fmt} />
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
            setShowNew(false);
            setTab("content");
            fetchList(appliedTerm, pageNo);
            openConfig({ dataId, group, content: "", configType: "" });
          }}
        />
      )}

      {showDelete && selected && (
        <DeleteConfirm name={selected.dataId} group={selected.group} onCancel={() => setShowDelete(false)} onConfirm={doDelete} />
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

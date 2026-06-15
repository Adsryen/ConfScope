import { useEffect, useRef, useState } from "react";
import { Connection } from "../store/connections";
import { ConfigItem, deleteConfig, getConfig, listConfigs, publishConfig } from "../api/nacos";
import { detectFormat, Format, FORMATS, nacosType } from "../lib/format";
import CodeEditor from "./CodeEditor";
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

/** 配置浏览：左侧 dataId 列表（可搜索、分页），右侧内容 / 历史 标签页。 */
export default function ConfigBrowser({ conn, tenant }: Props) {
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
      setListError(String(e));
      setItems([]);
      setTotal(0);
      setPages(1);
    } finally {
      if (my === listReqId.current) setListLoading(false);
    }
  };

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
    setSelected(item); // 立即高亮，与异步内容加载解耦
    setTab("content");
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
      setContentError(String(e));
      setContent("");
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
    setSaving(true);
    setSaveError(null);
    try {
      await publishConfig(conn, tenant, selected.dataId, selected.group, draft, nacosType(fmt));
      setEditing(false);
      await openConfig(selected); // 重新拉取最新内容
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  // 实际删除（由确认弹框调用，失败时抛出供弹框展示）。
  const doDelete = async () => {
    if (!selected) return;
    await deleteConfig(conn, tenant, selected.dataId, selected.group);
    setShowDelete(false);
    setSelected(null);
    setContent("");
    fetchList(appliedTerm, pageNo);
  };

  return (
    <div className="browser">
      <div className="browser-list">
        <div className="browser-search">
          <input
            className="search-input wide"
            placeholder="搜索 dataId…"
            value={search}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && fetchList(search, 1)}
          />
          <button className="btn btn-ghost btn-sm" onClick={() => fetchList(search, 1)}>
            搜索
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => fetchList(appliedTerm, pageNo)}
            title="刷新列表"
            disabled={listLoading}
          >
            ⟳
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowNew(true)}
            title="新建配置"
          >
            ＋
          </button>
        </div>
        <div className="browser-count">共 {total} 项</div>
        <div className="browser-items">
          {listLoading && <div className="pad-msg">加载中…</div>}
          {listError && <div className="pad-msg err">{listError}</div>}
          {!listLoading && !listError && items.length === 0 && (
            <div className="pad-msg">没有配置</div>
          )}
          {items.map((it) => {
            const active = selected?.dataId === it.dataId && selected?.group === it.group;
            return (
              <div
                key={`${it.group}/${it.dataId}`}
                className={`browser-item${active ? " active" : ""}`}
                onClick={() => openConfig(it)}
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
        <Pager
          page={pageNo}
          pages={pages}
          loading={listLoading}
          onPage={(p) => fetchList(appliedTerm, p)}
        />
      </div>

      <div className="browser-detail">
        {!selected ? (
          <div className="pad-msg big">从左侧选择一个配置查看</div>
        ) : (
          <>
            <div className="detail-header">
              <div className="detail-title">
                <span className="detail-dataid mono">{selected.dataId}</span>
                <span className="detail-group">
                  GROUP: {selected.group}
                  {selected.configType ? ` · ${selected.configType}` : ""}
                </span>
              </div>
              <div className="detail-tabs">
                <button
                  className={`tab-btn${tab === "content" ? " active" : ""}`}
                  onClick={() => setTab("content")}
                >
                  内容
                </button>
                <button
                  className={`tab-btn${tab === "history" ? " active" : ""}`}
                  onClick={() => setTab("history")}
                >
                  历史变更
                </button>
              </div>
            </div>

            {tab === "content" ? (
              <div className="content-box">
                {contentLoading && <div className="pad-msg">加载中…</div>}
                {contentError && <div className="pad-msg err">{contentError}</div>}
                {!contentLoading && !contentError && editing && (
                  <>
                    <div className="fmt-bar">
                      <span className="fmt-label">编辑 · 格式</span>
                      <Select
                        className="fmt-select"
                        value={fmt}
                        options={FORMATS.map((f) => ({ value: f, label: f }))}
                        onChange={(v) => setFmt(v as Format)}
                      />
                      {saveError && <span className="fmt-msg err">{saveError}</span>}
                      <span className="fmt-spacer" />
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setEditing(false);
                          setSaveError(null);
                        }}
                      >
                        取消
                      </button>
                      <button className="btn btn-primary btn-sm" onClick={saveEdit} disabled={saving}>
                        {saving ? "发布中…" : "保存发布"}
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
                      <span className="fmt-label">配置格式</span>
                      <Select
                        className="fmt-select"
                        value={fmt}
                        options={FORMATS.map((f) => ({ value: f, label: f }))}
                        onChange={(v) => setFmt(v as Format)}
                      />
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => selected && openConfig(selected)}
                        title="重新拉取内容"
                        disabled={contentLoading}
                      >
                        ⟳
                      </button>
                      <CopyButton text={content} />
                      <span className="fmt-spacer" />
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={startEdit}
                        disabled={contentLoading}
                      >
                        编辑
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setShowDelete(true)}
                        disabled={contentLoading}
                      >
                        删除
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
            fetchList(appliedTerm, pageNo);
            openConfig({ dataId, group, content: "", configType: "" });
          }}
        />
      )}

      {showDelete && selected && (
        <DeleteConfirm
          name={selected.dataId}
          group={selected.group}
          onCancel={() => setShowDelete(false)}
          onConfirm={doDelete}
        />
      )}
    </div>
  );
}

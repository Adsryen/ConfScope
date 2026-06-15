import { useEffect, useState } from "react";
import { Connection } from "../store/connections";
import { ConfigItem, getConfig, listConfigs } from "../api/nacos";
import HistoryView from "./HistoryView";

interface Props {
  conn: Connection;
  tenant: string;
}

const PAGE_SIZE = 100;
type Tab = "content" | "history";

/** 配置浏览：左侧 dataId 列表（可搜索），右侧内容 / 历史 标签页。 */
export default function ConfigBrowser({ conn, tenant }: Props) {
  const [search, setSearch] = useState("");
  const [items, setItems] = useState<ConfigItem[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selected, setSelected] = useState<ConfigItem | null>(null);
  const [content, setContent] = useState("");
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("content");

  const fetchList = async (term: string) => {
    setListLoading(true);
    setListError(null);
    try {
      // blur 搜索：用 *term* 模糊匹配 dataId；term 为空则列全部
      const dataId = term.trim() ? `*${term.trim()}*` : "";
      const page = await listConfigs(conn, tenant, dataId, "", 1, PAGE_SIZE);
      setItems(page.pageItems);
      setTotal(page.totalCount);
    } catch (e) {
      setListError(String(e));
      setItems([]);
      setTotal(0);
    } finally {
      setListLoading(false);
    }
  };

  // 切换连接 / 命名空间时重置并重新拉列表
  useEffect(() => {
    setSearch("");
    setSelected(null);
    setContent("");
    fetchList("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, tenant]);

  const openConfig = async (item: ConfigItem) => {
    setSelected(item);
    setTab("content");
    setContentLoading(true);
    setContentError(null);
    try {
      const text = await getConfig(conn, tenant, item.dataId, item.group);
      setContent(text);
    } catch (e) {
      setContentError(String(e));
      setContent("");
    } finally {
      setContentLoading(false);
    }
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
            onKeyDown={(e) => e.key === "Enter" && fetchList(search)}
          />
          <button className="btn btn-ghost btn-sm" onClick={() => fetchList(search)}>
            搜索
          </button>
        </div>
        <div className="browser-count">
          共 {total} 项{items.length < total ? `（显示前 ${items.length}）` : ""}
        </div>
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
                {!contentLoading && !contentError && (
                  <pre className="code-area mono">{content}</pre>
                )}
              </div>
            ) : (
              <HistoryView
                conn={conn}
                tenant={tenant}
                dataId={selected.dataId}
                group={selected.group}
                currentContent={content}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

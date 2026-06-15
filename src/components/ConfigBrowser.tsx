import { useEffect, useRef, useState } from "react";
import { Connection } from "../store/connections";
import { ConfigItem, getConfig, listConfigs } from "../api/nacos";
import { beautify, detectFormat, Format, FORMATS } from "../lib/format";
import CodeView from "./CodeView";
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
  // 格式与美化：fmt 为当前选定格式；beautified 非空时展示美化后的内容
  const [fmt, setFmt] = useState<Format>("TEXT");
  const [beautified, setBeautified] = useState<string | null>(null);
  const [fmtError, setFmtError] = useState<string | null>(null);

  const doBeautify = (format: Format) => {
    const r = beautify(content, format);
    if (r.ok) {
      setBeautified(r.text);
      setFmtError(r.reformatted ? null : "该格式仅做轻量规整（保留注释/顺序）");
    } else {
      setBeautified(null);
      setFmtError(`美化失败：${r.error ?? "内容不是合法的 " + format}`);
    }
  };

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

  // 每次打开配置自增，异步结果只在仍是最新一次请求时才采用，避免连点串台。
  const reqId = useRef(0);

  const openConfig = async (item: ConfigItem) => {
    const my = ++reqId.current;
    setSelected(item); // 立即高亮，与异步内容加载解耦
    setTab("content");
    setContentLoading(true);
    setContentError(null);
    setBeautified(null);
    setFmtError(null);
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
                  <>
                    <div className="fmt-bar">
                      <span className="fmt-label">配置格式</span>
                      <select
                        className="search-input fmt-select"
                        value={fmt}
                        onChange={(e) => {
                          const next = e.target.value as Format;
                          setFmt(next);
                          if (beautified !== null) doBeautify(next);
                          else setFmtError(null);
                        }}
                      >
                        {FORMATS.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                      {beautified === null ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => doBeautify(fmt)}
                          disabled={!content}
                        >
                          ✨ 美化
                        </button>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm active"
                          onClick={() => {
                            setBeautified(null);
                            setFmtError(null);
                          }}
                        >
                          还原原始
                        </button>
                      )}
                      {fmtError && <span className="fmt-msg">{fmtError}</span>}
                    </div>
                    <CodeView code={beautified ?? content} format={fmt} />
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
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Connection } from "../store/connections";
import {
  formatTime,
  getHistoryDetail,
  HistoryItem,
  listHistory,
  publishConfig,
} from "../api/nacos";
import { Format, nacosType } from "../lib/format";
import CodeView from "./CodeView";
import CopyButton from "./CopyButton";
import DiffPanel from "./DiffPanel";
import Pager from "./Pager";
import UnifiedDiff from "./UnifiedDiff";

interface Props {
  conn: Connection;
  tenant: string;
  dataId: string;
  group: string;
  /** 当前线上内容，作为「与最新版对比」的右侧基准。 */
  currentContent: string;
  /** 配置格式，用于原始内容的语法高亮与回滚发布时的 type。 */
  format: Format;
  /** 回滚成功后通知父级刷新当前内容。 */
  onRolledBack: () => void;
}

const PAGE_SIZE = 50;
const opLabel = (t: string) =>
  ({ I: "新增", U: "更新", D: "删除" } as Record<string, string>)[t] ?? t ?? "—";

/** 历史版本：左侧版本列表（可勾选两个对比），右侧展示选中版本内容或两版本 diff。 */
export default function HistoryView({
  conn,
  tenant,
  dataId,
  group,
  currentContent,
  format,
  onRolledBack,
}: Props) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageNo, setPageNo] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 勾选用于对比的版本 nid（最多两个），以及缓存的版本内容
  const [picked, setPicked] = useState<string[]>([]);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [viewing, setViewing] = useState<string | null>(null);
  // 单版本查看时：默认高亮「相对上一版的变更」，可切到原始内容
  const [rawView, setRawView] = useState(false);
  // 回滚：二次确认 + 进行中
  const [rbConfirm, setRbConfirm] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  const histReqId = useRef(0);

  const loadHistory = (page: number) => {
    const my = ++histReqId.current;
    setLoading(true);
    setError(null);
    setPageNo(page);
    listHistory(conn, tenant, dataId, group, page, PAGE_SIZE)
      .then((res) => {
        if (my !== histReqId.current) return;
        setItems(res.pageItems);
        setTotal(res.totalCount);
        setPages(Math.max(res.pagesAvailable || 1, 1));
      })
      .catch((e) => {
        if (my !== histReqId.current) return;
        setError(String(e));
        setItems([]);
        setPages(1);
      })
      .finally(() => {
        if (my === histReqId.current) setLoading(false);
      });
  };

  useEffect(() => {
    setItems([]);
    setPicked([]);
    setContents({});
    setViewing(null);
    setRawView(false);
    loadHistory(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, tenant, dataId, group]);

  // 拉取某个版本的内容（带缓存）
  const ensureContent = async (nid: string): Promise<string> => {
    if (contents[nid] !== undefined) return contents[nid];
    const d = await getHistoryDetail(conn, tenant, dataId, group, nid);
    setContents((c) => ({ ...c, [nid]: d.content }));
    return d.content;
  };

  const togglePick = async (nid: string) => {
    setError(null);
    let next: string[];
    if (picked.includes(nid)) {
      next = picked.filter((x) => x !== nid);
    } else {
      next = [...picked, nid].slice(-2); // 最多保留最近勾选的两个
    }
    setPicked(next);
    try {
      await Promise.all(next.map(ensureContent));
    } catch (e) {
      setError(String(e));
    }
  };

  // 找某版本的「上一版」：id 比它小、且最大的那个（id 越大越新）。
  const prevOf = (nid: string): HistoryItem | undefined =>
    items
      .filter((i) => Number(i.id) < Number(nid))
      .sort((a, b) => Number(b.id) - Number(a.id))[0];

  // 回滚：把选中版本的内容重新发布为最新版（Nacos 无专用回滚接口）。
  const rollback = async () => {
    if (!viewing) return;
    if (!rbConfirm) {
      setRbConfirm(true);
      return;
    }
    setRollingBack(true);
    setError(null);
    try {
      const text = await ensureContent(viewing);
      await publishConfig(conn, tenant, dataId, group, text, nacosType(format));
      setRbConfirm(false);
      setViewing(null);
      onRolledBack();
      loadHistory(1);
    } catch (e) {
      setError(String(e));
      setRbConfirm(false);
    } finally {
      setRollingBack(false);
    }
  };

  const view = (nid: string) => {
    setError(null);
    setRbConfirm(false);
    setViewing(nid); // 立即高亮，内容后台加载，避免连点时被慢请求覆盖
    const prev = prevOf(nid);
    Promise.all([
      ensureContent(nid),
      prev ? ensureContent(prev.id) : Promise.resolve(""),
    ]).catch((e) => setError(String(e)));
  };

  // 对比：勾选 2 个 → 两版本对比；勾选 1 个 → 该版本 vs 当前线上
  const comparing = picked.length >= 1;
  const sorted = [...picked].sort((a, b) => Number(a) - Number(b)); // nid 小=旧
  const leftNid = sorted[0];
  const rightNid = sorted[1];
  const itemOf = (nid: string) => items.find((i) => i.id === nid);

  return (
    <div className="history-view">
      <div className="history-list">
        <div className="history-list-head">
          历史版本（{total}）
          <span className="history-hint">勾选 1 个与线上对比 · 勾选 2 个互相对比</span>
        </div>
        <div className="history-items">
        {loading && <div className="pad-msg">加载中…</div>}
        {error && <div className="pad-msg err">{error}</div>}
        {!loading && !error && items.length === 0 && <div className="pad-msg">暂无历史记录</div>}
        {items.map((h) => (
          <div
            key={h.id}
            className={`history-item${viewing === h.id ? " active" : ""}${
              picked.includes(h.id) ? " picked" : ""
            }`}
          >
            <input
              type="checkbox"
              checked={picked.includes(h.id)}
              onChange={() => togglePick(h.id)}
              title="勾选用于对比"
            />
            <div className="history-item-main" onClick={() => view(h.id)}>
              <div className="history-item-time">{formatTime(h.lastModifiedTime)}</div>
              <div className="history-item-meta">
                <span className={`op op-${h.opType || "x"}`}>{opLabel(h.opType)}</span>
                <span className="history-item-id mono">nid {h.id}</span>
              </div>
            </div>
          </div>
        ))}
        </div>
        <Pager page={pageNo} pages={pages} loading={loading} onPage={(p) => loadHistory(p)} />
      </div>

      <div className="history-detail">
        {comparing ? (
          (leftNid && contents[leftNid] === undefined) ||
          (rightNid && contents[rightNid] === undefined) ? (
            <div className="pad-msg">加载中…</div>
          ) : (
            <DiffPanel
              leftLabel={
                leftNid
                  ? `nid ${leftNid} · ${formatTime(itemOf(leftNid)?.lastModifiedTime ?? "")}`
                  : "（无）"
              }
              rightLabel={
                rightNid
                  ? `nid ${rightNid} · ${formatTime(itemOf(rightNid)?.lastModifiedTime ?? "")}`
                  : "当前线上内容"
              }
              leftText={leftNid ? contents[leftNid] ?? "" : ""}
              rightText={rightNid ? contents[rightNid] ?? "" : currentContent}
              format={format}
            />
          )
        ) : viewing ? (
          (() => {
            const prev = prevOf(viewing);
            const ready =
              contents[viewing] !== undefined && (!prev || contents[prev.id] !== undefined);
            return (
              <div className="content-box">
                <div className="content-box-head">
                  <span>
                    nid {viewing} · {formatTime(itemOf(viewing)?.lastModifiedTime ?? "")}
                    {prev ? (
                      <span className="vs-prev"> · 相对上一版 nid {prev.id} 的变更</span>
                    ) : (
                      <span className="vs-prev"> · 首个版本（无上一版）</span>
                    )}
                  </span>
                  <span className="head-actions">
                    <button
                      className={`btn btn-ghost btn-sm${rawView ? "" : " active"}`}
                      onClick={() => setRawView((v) => !v)}
                    >
                      {rawView ? "高亮变更" : "原始内容"}
                    </button>
                    <CopyButton text={contents[viewing] ?? ""} label="复制本版" />
                    <button
                      className={`btn btn-sm ${rbConfirm ? "btn-danger" : "btn-ghost"}`}
                      onClick={rollback}
                      onBlur={() => setRbConfirm(false)}
                      disabled={rollingBack}
                      title="将此版本内容重新发布为最新版"
                    >
                      {rollingBack ? "回滚中…" : rbConfirm ? "确认回滚?" : "回滚到此版本"}
                    </button>
                  </span>
                </div>
                {!ready ? (
                  <div className="pad-msg">加载中…</div>
                ) : rawView ? (
                  <CodeView code={contents[viewing] ?? ""} format={format} />
                ) : (
                  <UnifiedDiff
                    oldText={prev ? contents[prev.id] ?? "" : ""}
                    newText={contents[viewing] ?? ""}
                    format={format}
                  />
                )}
              </div>
            );
          })()
        ) : (
          <div className="pad-msg">点击左侧版本查看内容，或勾选版本进行对比</div>
        )}
      </div>
    </div>
  );
}

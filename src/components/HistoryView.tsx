import { useDeferredValue, useEffect, useRef, useState } from "react";
import { Connection } from "../store/connections";
import {
  formatTime,
  getHistoryDetail,
  HistoryItem,
  listHistory,
} from "../api/nacos";
import type { ApplyEntryPayload } from "../lib/applyEntry";
import { detectFormat, Format } from "../lib/format";
import { buildDirectWriteExitEntry, isWritableConfigTarget } from "../lib/directWriteExit";
import { busyProps } from "../lib/busyRegion";
import { reportError } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import { useTranslation } from "../i18n";
import { connectionLabel } from "../lib/defaultNameCopy";
import CodeView from "./CodeView";
import CopyButton from "./CopyButton";
import { clickableRowProps } from "../lib/clickableRow";
import DiffPanel from "./DiffPanel";
import Pager from "./Pager";
import UnifiedDiff from "./UnifiedDiff";
import { errorText } from "../lib/errorText";
import { statusMessageProps } from "../lib/statusSemantics";

interface Props {
  conn: Connection;
  tenant: string;
  dataId: string;
  group: string;
  /** 当前线上内容，作为「与最新版对比」的右侧基准。 */
  currentContent: string;
  /** 配置格式：用于原始内容的语法高亮，也写进回滚计划项，让计划页按同一格式解析与比对。 */
  format: Format;
  /**
   * 交出「生成回滚变更计划」的出路（轮42）。
   *
   * 这里曾经是一个 `onRolledBack`：直写在 API 层被硬禁用后，回滚永远走不到成功分支，
   * 那个回调一行代码都没调用过，却挂着「将此版本内容重新发布为最新版」的按钮标题说谎。
   * 现在换成真正的出路：把该版本的正文物成成计划的来源值，交给计划流程 dry-run→确认→执行。
   */
  onStartApply?: (payload: ApplyEntryPayload) => void;
  /** 宿主页面被保活隐藏时传 false：本页的 CodeView 不再劫持全局 Ctrl+F。 */
  active?: boolean;
  /**
   * 页面级正文搜索词（配置浏览「按内容搜索」模式的词），原样透传给两个内容视图：
   * 「原始内容」的 CodeView 与**默认的**「高亮变更」UnifiedDiff。
   *
   * 词只有 ConfigBrowser 一个来源（`isContentSearchActive ? contentTerm : undefined`），
   * 本页不再起第二份搜索状态、也不复制 searchMode 判定：标红、命中行底色、行号当前态、
   * 缩略图红条、首处命中定位、Ctrl+F 预填全部复用 CodeView 已有的那一套（轮40 R40-1/R40-2）；
   * diff 侧复用同一套标记层（轮41 R41-1/R41-2），只是命中行指示改成行号变红。
   * 缺省（按 dataId 搜索或空词）时必须传 undefined：正文一处都不许标。
   */
  searchTerm?: string;
}

/** 按需拉取并缓存的历史版本正文与该版本自己的元信息。 */
interface HistoryVersion {
  content: string;
  /** 该版本发布时的格式（extInfo.type），服务端没给则空串。 */
  format: string;
  srcIp: string;
  srcUser: string;
}

const PAGE_SIZE = 50;
const opLabel = (opType: string, t: (key: string) => string) => {
  if (opType === "I") return t("history.opCreated");
  if (opType === "U") return t("history.opUpdated");
  if (opType === "D") return t("history.opDeleted");
  return opType || "—";
};

/** 历史版本：左侧版本列表（可勾选两个对比），右侧展示选中版本内容或两版本 diff。 */
export default function HistoryView({
  conn,
  tenant,
  dataId,
  group,
  currentContent,
  format,
  active = true,
  searchTerm,
  onStartApply,
}: Props) {
  const { t } = useTranslation();
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageNo, setPageNo] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 勾选用于对比的版本 nid（最多两个），以及缓存的版本内容
  const [picked, setPicked] = useState<string[]>([]);
  // 版本正文 + 该版本自己的元信息（正文按需拉取，缓存到这里；undefined = 还没拉过）
  const [contents, setContents] = useState<Record<string, HistoryVersion>>({});
  const [viewing, setViewing] = useState<string | null>(null);
  // 重内容渲染（diff/高亮）用延迟值：点击后左侧高亮先即时刷新，
  // 右侧重渲染延后，切换时先显示「加载中」，不卡点击反馈。
  const deferredViewing = useDeferredValue(viewing);
  // 单版本查看时：默认高亮「相对上一版的变更」，可切到原始内容
  const [rawView, setRawView] = useState(false);
  // 回滚：二次确认 + 生成计划中
  const [rbConfirm, setRbConfirm] = useState(false);
  const [generatingPlan, setGeneratingPlan] = useState(false);

  const histReqId = useRef(0);
  const sourceLabel = `${connectionLabel(conn, t)} / ${tenant || "public"} / ${group} / ${dataId}`;
  // 只读连接与本地快照没有可写的计划目标：不出「生成回滚计划」这颗永远走不通的按钮（R42-8）。
  const canRollback = isWritableConfigTarget(conn);

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
        const message = errorText(e);
        setError(message);
        setItems([]);
        setPages(1);
        reportError({
          title: t("history.loadVersionsFailed"),
          source: sourceLabel,
          message,
          detail: message,
          actionLabel: t("common.retry"),
          onAction: () => loadHistory(page),
        });
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
  const ensureVersion = async (nid: string): Promise<HistoryVersion> => {
    const cached = contents[nid];
    if (cached !== undefined) return cached;
    const d = await getHistoryDetail(conn, tenant, dataId, group, nid);
    const version: HistoryVersion = {
      content: d.content,
      format: d.format ?? "",
      srcIp: d.srcIp ?? "",
      srcUser: d.srcUser ?? "",
    };
    setContents((c) => ({ ...c, [nid]: version }));
    return version;
  };

  const ensureContent = async (nid: string): Promise<string> => (await ensureVersion(nid)).content;

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
      const message = errorText(e);
      setError(message);
      reportError({
        title: t("history.contentLoadFailed"),
        source: sourceLabel,
        message,
        detail: message,
      });
    }
  };

  /**
   * 该版本正文的渲染格式（轮55 R55-E4）。
   *
   * 真机取证：Nacos 把发布时的 type 存进历史行的 extInfo（实测 `{"type":"yaml"}`），
   * 所以历史正文该按**那一版自己**的格式高亮——用当前配置的格式去渲染旧版，
   * 旧版是 properties、新版已改 yaml 时，整屏高亮是错的。服务端没给则回退当前格式。
   */
  const versionFormat = (nid: string | null | undefined): Format => {
    const version = nid ? contents[nid] : undefined;
    if (!version?.format) return format;
    return detectFormat(dataId, version.format, version.content);
  };

  /** 列表行与详情头的「发布来源」：优先用户名，Nacos 常只回 srcIp。 */
  const publisherOf = (nid: string | null | undefined): string => {
    const version = nid ? contents[nid] : undefined;
    const item = nid ? itemOf(nid) : undefined;
    return version?.srcUser || item?.srcUser || version?.srcIp || item?.srcIp || "";
  };

  // 找某版本的「上一版」：id 比它小、且最大的那个（id 越大越新）。
  const prevOf = (nid: string): HistoryItem | undefined =>
    items
      .filter((i) => Number(i.id) < Number(nid))
      .sort((a, b) => Number(b.id) - Number(a.id))[0];

  /**
   * 回滚 = 生成「把这个版本的内容变回去」的变更计划（轮42 / 方案 D）。
   * Nacos 没有专用回滚接口，直写又已被硬禁用，所以唯一的出路就是计划：
   * 来源值 = 该历史版本正文，目标 = 线上现值，计划页会渲染成一条覆盖项。
   * 两步就地确认保留（点第一下只改文案，不误触）；执行侧仍要 dry-run + 勾选确认。
   */
  /**
   * 真正干活的一段：读版本正文 → 物化计划 → 交给计划流程。
   * 独立出来是为了让消息中心那条「重试」能直接重跑它：
   * 用户在就地确认上已经点过第二下了，重试不该把他退回第一步重新确认。
   */
  const generateRollbackPlan = async (targetVersion: string) => {
    setGeneratingPlan(true);
    setError(null);
    try {
      const text = await ensureContent(targetVersion);
      const entry = buildDirectWriteExitEntry({
        conn,
        t,
        namespace: tenant,
        group,
        dataId,
        format,
        desiredContent: text,
        intent: "rollback",
      });
      if (!entry || !onStartApply) {
        setError(t("config.planRouteUnavailable"));
        return;
      }
      onStartApply(entry);
      toast(t("config.planCreated"));
    } catch (e) {
      // 读不到版本正文是真错误：它可能只是网络抖一下，重试有意义。
      const message = errorText(e);
      setError(message);
      reportError({
        title: t("history.contentLoadFailed"),
        source: sourceLabel,
        message,
        detail: message,
        actionLabel: t("common.retry"),
        onAction: () => generateRollbackPlan(targetVersion),
      });
    } finally {
      setGeneratingPlan(false);
    }
  };

  const rollback = async () => {
    if (!viewing) return;
    if (!rbConfirm) {
      setRbConfirm(true);
      return;
    }
    setRbConfirm(false);
    await generateRollbackPlan(viewing);
  };

  const view = (nid: string) => {
    setError(null);
    setRbConfirm(false);
    setViewing(nid); // 立即高亮，内容后台加载，避免连点时被慢请求覆盖
    const prev = prevOf(nid);
    Promise.all([
      ensureContent(nid),
      prev ? ensureContent(prev.id) : Promise.resolve(""),
    ]).catch((e) => {
      const message = errorText(e);
      setError(message);
      reportError({
        title: t("history.contentLoadFailed"),
        source: sourceLabel,
        message,
        detail: message,
      });
    });
  };

  // 对比：勾选 2 个 → 两版本对比；勾选 1 个 → 该版本 vs 当前线上
  const comparing = picked.length >= 1;
  const sorted = [...picked].sort((a, b) => Number(a) - Number(b)); // nid 小=旧
  const leftNid = sorted[0];
  const rightNid = sorted[1];
  const itemOf = (nid: string) => items.find((i) => i.id === nid);

  // 对比要用的两份版本内容是按需拉取的：没回来之前这一整块正在被异步替换（波36 R55）。
  const missingContent = (nid: string) => !!nid && contents[nid] === undefined;
  const comparePending = comparing && (missingContent(leftNid) || missingContent(rightNid));

  return (
    <div className="history-view">
      <div className="history-list">
        <div className="history-list-head">
          {t('history.title')}（{total}）
          <span className="history-hint">{t('history.pickHint')}</span>
        </div>
        <div className="history-items" {...busyProps(loading)}>
        {loading && (
          <div className="pad-msg" role="status" aria-live="polite">
            {t("common.loading")}
          </div>
        )}
        {error && (
          <div className="pad-msg err" {...statusMessageProps("error")}>
            <span>{error}</span>
            <CopyButton text={error} label={t("common.copyError")} />
          </div>
        )}
        {!loading && !error && items.length === 0 && <div className="pad-msg">{t('history.empty')}</div>}
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
              aria-label={t("history.pickForCompare")}
              title={t("history.pickForCompare")}
            />
            <div
              className="history-item-main"
              onClick={() => view(h.id)}
              {...clickableRowProps(() => view(h.id), { selected: viewing === h.id })}
            >
              <div className="history-item-time">{formatTime(h.lastModifiedTime)}</div>
              <div className="history-item-meta">
                <span className={`op op-${h.opType || "x"}`}>{opLabel(h.opType, t)}</span>
                <span className="history-item-id mono">nid {h.id}</span>
                {(h.srcUser || h.srcIp) && (
                  <span className="history-item-src mono" title={`${t("history.publisher")}: ${h.srcUser || h.srcIp}`}>
                    {h.srcUser || h.srcIp}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
        </div>
        <Pager page={pageNo} pages={pages} loading={loading} onPage={(p) => loadHistory(p)} />
      </div>

      <div className="history-detail" {...busyProps(comparePending)}>
        {comparing ? (
          (leftNid && contents[leftNid] === undefined) ||
          (rightNid && contents[rightNid] === undefined) ? (
            <div className="pad-msg" role="status" aria-live="polite">
              {t("common.loading")}
            </div>
          ) : (
            <DiffPanel
              leftLabel={
                leftNid
                  ? `nid ${leftNid} · ${formatTime(itemOf(leftNid)?.lastModifiedTime ?? "")}`
                  : t('history.noContent')
              }
              rightLabel={
                rightNid
                  ? `nid ${rightNid} · ${formatTime(itemOf(rightNid)?.lastModifiedTime ?? "")}`
                  : t('history.currentOnline')
              }
              leftText={leftNid ? contents[leftNid]?.content ?? "" : ""}
              rightText={rightNid ? contents[rightNid]?.content ?? "" : currentContent}
              format={versionFormat(rightNid ?? leftNid)}
              active={active}
            />
          )
        ) : viewing ? (
          (() => {
            const headPrev = prevOf(viewing); // 头部即时反映点击的版本
            const dv = deferredViewing; // 重渲染用延迟值
            const switching = viewing !== deferredViewing;
            const prev = dv ? prevOf(dv) : undefined;
            const ready =
              !switching &&
              dv != null &&
              contents[dv] !== undefined &&
              (!prev || contents[prev.id] !== undefined);
            return (
              <div className="content-box" {...busyProps(!ready)}>
                <div className="content-box-head">
                  <span>
                    nid {viewing} · {formatTime(itemOf(viewing)?.lastModifiedTime ?? "")}
                    {publisherOf(viewing) && (
                      <span className="history-publisher mono" title={t("history.publisher")}>
                        {publisherOf(viewing)}
                      </span>
                    )}
                    {headPrev ? (
                      <span className="vs-prev"> · {t('history.vsPrev', { nid: headPrev.id })}</span>
                    ) : (
                      <span className="vs-prev"> · {t('history.firstVersion')}</span>
                    )}
                  </span>
                  <span className="head-actions">
                    {/*
                      分段控件（轮49 R49-03）。原先这里是一颗按钮同时改文案、改 active、改 aria-pressed，
                      而三者指向的是「另一个视图」：屏幕显示高亮变更时，按钮上写着「原始内容」却是按下态，
                      读屏念出「原始内容，已按下」就把人指到了根本没显示的那个视图。
                      拆成两颗恒定命名的按钮——哪个视图在屏上，active 与 aria-pressed 就在同名那颗上。
                      （守卫 tests/ux/historyViewModeToggleTellsTruth；真机 DF2-06 钉的是用户看得见的 class。）
                    */}
                    <div className="view-mode" role="group" aria-label={t("history.viewMode")}>
                      <button
                        type="button"
                        className={`btn btn-ghost btn-sm${rawView ? "" : " active"}`}
                        aria-pressed={!rawView}
                        onClick={() => setRawView(false)}
                      >
                        {t("history.highlightChanges")}
                      </button>
                      <button
                        type="button"
                        className={`btn btn-ghost btn-sm${rawView ? " active" : ""}`}
                        aria-pressed={rawView}
                        onClick={() => setRawView(true)}
                      >
                        {t("history.rawContent")}
                      </button>
                    </div>
                    <CopyButton text={contents[viewing]?.content ?? ""} label={t('history.copyVersion')} />
                    {canRollback && (
                      <button
                        className={`btn btn-sm ${rbConfirm ? "btn-danger-fill" : "btn-ghost"}`}
                        onClick={rollback}
                        onBlur={() => setRbConfirm(false)}
                        disabled={generatingPlan}
                      >
                        {generatingPlan
                          ? t("config.generatingPlan")
                          : rbConfirm
                            ? t("history.confirmRollbackAsPlan")
                            : t("history.rollbackAsPlan")}
                      </button>
                    )}
                  </span>
                </div>
                {!ready ? (
                  <div className="pad-msg" role="status" aria-live="polite">
                    {t("common.loading")}
                  </div>
                ) : rawView ? (
                  <CodeView
                    code={contents[dv!]?.content ?? ""}
                    format={versionFormat(dv)}
                    active={active}
                    searchTerm={searchTerm}
                    contentKey={`${tenant}::${group}::${dataId}::${dv}`}
                  />
                ) : (
                  <UnifiedDiff
                    oldText={prev ? contents[prev.id]?.content ?? "" : ""}
                    newText={contents[dv!]?.content ?? ""}
                    format={versionFormat(dv)}
                    searchTerm={searchTerm}
                    active={active}
                  />
                )}
              </div>
            );
          })()
        ) : (
          <div className="pad-msg">{t('history.selectHint')}</div>
        )}
      </div>
    </div>
  );
}

/**
 * 本机配置版本历史面板（轮67 R57-WP15）。
 *
 * 与服务端历史（HistoryView）并列、不合并（R7）：两边说的不是同一件事——
 * 服务端那一列是「配置中心记下的那次发布」，本机这一列只是「这台机器在什么时刻见过哪一版」。
 * 硬拼成一列会造出「看着像历史、其实缺项」的假数据，所以各占一屏，
 * 时间列的 title 与列表头 hint 都按 R6 说实话，绝不冒充配置中心的发布时间。
 *
 * 正文就在记录里带着（超单条上限的除外），不像服务端历史要按 nid 二次拉详情，
 * 因此这里没有「点一下才发现正文取不到」的中间态；相应地也不分页——
 * 每个配置键本机最多留 keepPerKey 条，一次读完比翻页更诚实。
 */
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Connection } from "../store/connections";
import { formatTime } from "../api/nacos";
import type { ConfigRevisionPolicyView, ConfigRevisionRecord } from "../../wailsjs/go/app/App";
import type { ApplyEntryPayload } from "../lib/applyEntry";
import {
  CONFIG_REVISION_CONTENT_OMITTED_TOO_LARGE,
  CONFIG_REVISION_KIND_CONFIRMED_WRITE,
  getConfigRevisionPolicy,
  isRevisionPinned,
  listRevisionsForKey,
  revisionPolicyStoreAvailable,
  toggleRevisionPinned,
} from "../lib/configRevisions";
import { detectFormat, Format } from "../lib/format";
import { buildDirectWriteExitEntry, isWritableConfigTarget } from "../lib/directWriteExit";
import { busyProps } from "../lib/busyRegion";
import { reportError } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import { useTranslation } from "../i18n";
import { formatBytes } from "../lib/formatBytes";
import { connectionLabel } from "../lib/defaultNameCopy";
import CodeView from "./CodeView";
import CopyButton from "./CopyButton";
import { clickableRowProps } from "../lib/clickableRow";
import DiffPanel from "./DiffPanel";
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
  format: Format;
  onStartApply?: (payload: ApplyEntryPayload) => void;
  /** 宿主页面被保活隐藏时传 false：本面板的 CodeView 不再劫持全局 Ctrl+F。 */
  active?: boolean;
  /**
   * 页面级正文搜索词，原样透传给两个内容视图。
   *
   * 只有 ConfigBrowser 一个出处，本面板不起第二份搜索状态、不复制判定：标红、命中行底色、
   * 行号当前态、缩略图红条、首处命中定位、Ctrl+F 预填全部复用 CodeView / UnifiedDiff 那一套。
   * 缺省时必须传 undefined：正文一处都不许标。
   */
  searchTerm?: string;
}

/** 一条记录连同它的稳定标识与新旧位次。 */
interface RevisionEntry {
  id: string;
  rec: ConfigRevisionRecord;
  /** 在「最新在前」的列表里的下标：越大越旧，上一版就是 index + 1。 */
  index: number;
}

/**
 * 记录标识：Go 落的是 RFC3339Nano 时刻，同一键在同一纳秒写两条实际不会发生；
 * 万一缺刻（旧数据/异常写入）退回下标，至少不撞 key。
 * 不用下标当主键：新记录一落，所有下标整体后移，勾选与查看会跳到别的版本上。
 */
function revisionId(rec: ConfigRevisionRecord, index: number): string {
  return rec.ts || `#${index}`;
}

/** 摘要短码：去掉 `sha256:` 前缀取前 12 位，完整值放 title。 */
function hashShort(hash: string): string {
  const bare = hash.replace(/^sha256:/, "");
  return bare ? bare.slice(0, 12) : "—";
}

/** 本机版本历史：左侧记录列表（可勾选两条互相对比），右侧正文或差异。 */
export default function LocalRevisionPanel({
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
  const [records, setRecords] = useState<ConfigRevisionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 勾选用于对比的记录 id（最多两个），与 HistoryView 同一交互口径
  const [picked, setPicked] = useState<string[]>([]);
  const [viewing, setViewing] = useState<string | null>(null);
  // 重内容渲染（diff/高亮）用延迟值：点击后左侧高亮先即时刷新，右侧重渲染延后
  const deferredViewing = useDeferredValue(viewing);
  const [rawView, setRawView] = useState(false);
  const [rbConfirm, setRbConfirm] = useState(false);
  const [generatingPlan, setGeneratingPlan] = useState(false);
  // 轮99：钉住这一版正文。清单来自保留策略（与设置页同一个事实源）；
  // 策略读不出来（绑定缺失/磁盘那份坏了）时整排钉住键不出现——
  // 摆一颗永远点不动、还说不清钉没钉上的键，比没有这颗键更坏。
  const [policyView, setPolicyView] = useState<ConfigRevisionPolicyView | null>(null);
  const [pinBusyId, setPinBusyId] = useState("");

  const reqId = useRef(0);
  const sourceLabel = `${connectionLabel(conn, t)} / ${tenant || "public"} / ${group} / ${dataId}`;

  const load = async () => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const list = await listRevisionsForKey(conn, { namespace: tenant, group, dataId });
      if (id !== reqId.current) return;
      setRecords(list);
      // 读成功就把上一轮的失败提示收掉：重试后还挂着红字会让人以为仍没读出来
      setError(null);
    } catch (e) {
      if (id !== reqId.current) return;
      // 「读不出来」与「真的没记过」必须分开说（Go 侧已按这个口径拆返回值）：
      // 把失败说成空历史，等于在最可疑的时刻告诉用户「这一版本机没记过」。
      const message = errorText(e);
      setError(message);
      reportError({
        title: t("history.localLoadFailed"),
        source: sourceLabel,
        message,
        detail: message,
        actionLabel: t("common.retry"),
        onAction: () => {
          void load();
        },
      });
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  };

  useEffect(() => {
    setPicked([]);
    setViewing(null);
    setRbConfirm(false);
    setError(null);
    setRawView(false);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn.id, tenant, dataId, group]);

  // 钉住清单跟着键走（与上面 load 同一个口径）：换配置要看的就是这一排键的钉住状态。
  useEffect(() => {
    if (!revisionPolicyStoreAvailable()) {
      setPolicyView(null);
      return;
    }
    let alive = true;
    void getConfigRevisionPolicy()
      .then((view) => {
        if (alive) setPolicyView(view);
      })
      .catch(() => {
        // 读不出策略 = 钉没钉上都不确定，整排键不出现（见上面的状态注释）。
        if (alive) setPolicyView(null);
      });
    return () => {
      alive = false;
    };
  }, [conn.id, tenant, dataId, group]);

  const entries = useMemo<RevisionEntry[]>(() => records.map((rec, index) => ({ id: revisionId(rec, index), rec, index })), [records]);
  const entryOf = (id: string | null | undefined): RevisionEntry | undefined =>
    id === null || id === undefined ? undefined : entries.find((item) => item.id === id);

  /** 正文超单条上限 ⇒ 文件里只有摘要与字节数。渲染空串会冒充「这一版是空的」。 */
  const bodyOmitted = (entry: RevisionEntry | undefined): boolean =>
    entry?.rec.contentOmittedReason === CONFIG_REVISION_CONTENT_OMITTED_TOO_LARGE;

  const contentOf = (entry: RevisionEntry | undefined): string => (bodyOmitted(entry) ? "" : (entry?.rec.content ?? ""));

  /**
   * 这一版自己的格式（与 HistoryView 的 versionFormat 同一口径）。
   *
   * 记录里带的是读取那一刻的 format；旧版是 properties、现在已改 yaml 时，
   * 用当前格式渲染旧版整屏高亮都是错的，所以按记录自己的 format 判，缺省回退当前格式。
   */
  const entryFormat = (entry: RevisionEntry | undefined): Format => {
    if (!entry?.rec.format) return format;
    return detectFormat(dataId, entry.rec.format, entry.rec.content ?? "");
  };

  const isWritten = (rec: ConfigRevisionRecord): boolean => rec.kind === CONFIG_REVISION_KIND_CONFIRMED_WRITE;
  const kindClass = (rec: ConfigRevisionRecord): string => (isWritten(rec) ? "op op-U" : "op op-x");
  const kindLabel = (rec: ConfigRevisionRecord): string =>
    isWritten(rec) ? t("history.localKindWritten") : t("history.localKindObserved");

  /** 时刻的含义（R6）：observed 是首见，confirmed-write 是写入并回读确认，两者都不是发布时间。 */
  const timeTitle = (rec: ConfigRevisionRecord): string =>
    isWritten(rec) ? t("history.localWrittenTimeTitle") : t("history.localObservedTimeTitle");

  /** 这一版钉没钉：匹配只走 lib 里那一个 isRevisionPinned，面板不抄键结构。 */
  const isPinned = (rec: ConfigRevisionRecord): boolean =>
    policyView !== null && isRevisionPinned(policyView, conn.id, { namespace: tenant, group, dataId }, rec.hash);

  /*
   * 钉住 / 取消钉住（轮99）。身份是「键 + 正文摘要」不是时间戳：observed 会被就地升级成
   * confirmed-write 换掉整行含 ts，钉 ts 的钉会在那一刻静默失效。
   * 钉完以 Go 回读的策略刷新清单，界面上那颗键画的必须是磁盘上的事实；
   * result.pinned=false 且这次是想钉 ⇒ 本机已经没有这一版正文可钉（多半刚被裁掉），如实说出来。
   */
  const togglePin = async (entry: RevisionEntry) => {
    const hash = entry.rec.hash;
    if (!hash || pinBusyId) return;
    const next = !isPinned(entry.rec);
    setPinBusyId(entry.id);
    try {
      const result = await toggleRevisionPinned(conn, { namespace: tenant, group, dataId }, hash, next);
      if (revisionPolicyStoreAvailable()) {
        setPolicyView(await getConfigRevisionPolicy());
      }
      if (next && !result.pinned) {
        toast(t("history.localPinNoRow"), "info");
      } else {
        toast(result.pinned ? t("history.localPinned") : t("history.localUnpinned"));
      }
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setPinBusyId("");
    }
  };

  const togglePick = (id: string) => {
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-2)));
  };

  const view = (id: string) => {
    setRbConfirm(false);
    setViewing(id);
  };

  /** 上一条本机记录（更旧那一头）；被保留策略裁掉的中间版本不存在于这份日志里。 */
  const prevOf = (id: string): RevisionEntry | undefined => {
    const current = entryOf(id);
    if (!current) return undefined;
    return entries.find((item) => item.index === current.index + 1);
  };

  const canRollback = isWritableConfigTarget(conn) && Boolean(onStartApply);

  const generateRollbackPlan = async (entry: RevisionEntry) => {
    setGeneratingPlan(true);
    setError(null);
    try {
      const plan = buildDirectWriteExitEntry({
        conn,
        t,
        namespace: tenant,
        group,
        dataId,
        format: entryFormat(entry),
        desiredContent: entry.rec.content,
        intent: "rollback",
      });
      if (!plan || !onStartApply) {
        setError(t("config.planRouteUnavailable"));
        return;
      }
      onStartApply(plan);
      toast(t("config.planCreated"));
    } catch (e) {
      const message = errorText(e);
      setError(message);
      reportError({
        title: t("history.localPlanFailed"),
        source: sourceLabel,
        message,
        detail: message,
        actionLabel: t("common.retry"),
        onAction: () => {
          void generateRollbackPlan(entry);
        },
      });
    } finally {
      setGeneratingPlan(false);
    }
  };

  const rollback = (entry: RevisionEntry) => {
    if (!rbConfirm) {
      setRbConfirm(true);
      return;
    }
    setRbConfirm(false);
    void generateRollbackPlan(entry);
  };

  // 对比：勾选 2 个 → 两条记录互相对比；勾选 1 个 → 该记录 vs 当前线上
  const comparing = picked.length >= 1;
  const sortedIds = [...picked].sort((a, b) => (entryOf(b)?.index ?? 0) - (entryOf(a)?.index ?? 0)); // 下标大 = 更旧
  const leftEntry = entryOf(sortedIds[0]);
  const rightEntry = entryOf(sortedIds[1]);

  const viewingEntry = entryOf(viewing);
  const deferredEntry = entryOf(deferredViewing);
  const headPrev = viewingEntry ? prevOf(viewingEntry.id) : undefined;
  const switching = viewing !== deferredViewing;
  const ready = !switching && deferredEntry !== undefined;
  const prevEntry = deferredEntry ? prevOf(deferredEntry.id) : undefined;
  const detailBusy = loading && viewingEntry !== undefined;
  const omitted = bodyOmitted(viewingEntry);

  return (
    <div className="history-view">
      <div className="history-list">
        <div className="history-list-head">
          <div className="history-list-head-row">
            <span>
              {t("history.localTitle")}（{records.length}）
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}>
              {t("history.localReload")}
            </button>
          </div>
          <span className="history-hint">{t("history.localListHint")}</span>
          {/*
           * 「钉住」是什么、保住什么，写在这一行给整张清单看（轮99）。
           * 不挂每颗键的 title：那颗键在「另一颗正在处理」时是 disabled 的原生控件，
           * Blink 对 disabled 控件整段跳过 tooltip（tests/ux/disabledControlsDoNotRelyOnTitle 的取证），
           * 二十行重复同一句悬浮提示既点不动也读不到，反倒不如一处常驻说明。
           */}
          {policyView !== null && <span className="history-hint">{t("history.localPinHint")}</span>}
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
          {!loading && !error && entries.length === 0 && <div className="pad-msg">{t("history.localEmpty")}</div>}
          {entries.map((entry) => (
            <div
              key={entry.id}
              className={`history-item${viewing === entry.id ? " active" : ""}${picked.includes(entry.id) ? " picked" : ""}`}
            >
              <input
                type="checkbox"
                checked={picked.includes(entry.id)}
                onChange={() => togglePick(entry.id)}
                aria-label={t("history.pickForCompare")}
                title={t("history.pickForCompare")}
              />
              <div
                className="history-item-main"
                onClick={() => view(entry.id)}
                {...clickableRowProps(() => view(entry.id), { selected: viewing === entry.id })}
              >
                <div className="history-item-time">{formatTime(entry.rec.ts)}</div>
                <div className="history-item-meta">
                  <span className={kindClass(entry.rec)} title={timeTitle(entry.rec)}>
                    {kindLabel(entry.rec)}
                  </span>
                  <span className="history-item-id mono" title={entry.rec.hash}>
                    {hashShort(entry.rec.hash)}
                  </span>
                  <span className="history-item-id mono">{formatBytes(entry.rec.bytes)}</span>
                </div>
                {(entry.rec.firstSeenTs ||
                  entry.rec.planId ||
                  entry.rec.contentOmittedReason ||
                  (policyView !== null && isPinned(entry.rec))) && (
                  <div className="history-item-meta">
                    {entry.rec.contentOmittedReason && <span className="history-item-id">{t("history.localContentOmitted")}</span>}
                    {entry.rec.firstSeenTs && (
                      <span className="history-item-id" title={t("history.localFirstSeenTitle")}>
                        {t("history.localFirstSeen")} {formatTime(entry.rec.firstSeenTs)}
                      </span>
                    )}
                    {entry.rec.planId && (
                      <span className="history-item-id mono" title={entry.rec.planId}>
                        {t("history.localPlan")} {entry.rec.planId.slice(0, 8)}
                      </span>
                    )}
                    {policyView !== null && isPinned(entry.rec) && (
                      <span className="history-item-id pin-badge" title={t("history.localPinTitle")}>
                        {t("history.localPinned")}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {policyView !== null && entry.rec.hash && (
                <button
                  type="button"
                  className={`btn btn-ghost btn-sm history-item-pin${isPinned(entry.rec) ? " on" : ""}`}
                  aria-pressed={isPinned(entry.rec)}
                  disabled={pinBusyId !== ""}
                  onClick={() => void togglePin(entry)}
                >
                  {pinBusyId === entry.id
                    ? t("history.localPinBusy")
                    : isPinned(entry.rec)
                      ? t("history.localPinned")
                      : t("history.localPin")}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="history-detail" {...busyProps(detailBusy)}>
        {comparing ? (
          <DiffPanel
            leftLabel={leftEntry ? formatTime(leftEntry.rec.ts) : t("history.noContent")}
            rightLabel={rightEntry ? formatTime(rightEntry.rec.ts) : t("history.currentOnline")}
            leftText={contentOf(leftEntry)}
            rightText={rightEntry ? contentOf(rightEntry) : currentContent}
            format={entryFormat(rightEntry ?? leftEntry)}
            active={active}
          />
        ) : viewingEntry ? (
          (() => {
            const dv = deferredEntry;
            return (
              <div className="content-box" {...busyProps(switching)}>
                <div className="content-box-head">
                  <span>
                    {formatTime(viewingEntry.rec.ts)}
                    <span className="history-publisher mono" title={timeTitle(viewingEntry.rec)}>
                      {kindLabel(viewingEntry.rec)}
                    </span>
                    {headPrev ? (
                      <span className="vs-prev"> · {t("history.localVsPrev", { label: formatTime(headPrev.rec.ts) })}</span>
                    ) : (
                      <span className="vs-prev"> · {t("history.localFirst")}</span>
                    )}
                  </span>
                  <span className="head-actions">
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
                    <CopyButton text={contentOf(viewingEntry)} label={t("history.copyVersion")} />
                    {canRollback && !omitted && (
                      <button
                        className={`btn btn-sm ${rbConfirm ? "btn-danger-fill" : "btn-ghost"}`}
                        onClick={() => rollback(viewingEntry)}
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
                {omitted ? (
                  <div className="pad-msg">{t("history.localContentOmittedNote", { size: formatBytes(viewingEntry.rec.bytes) })}</div>
                ) : !ready ? (
                  <div className="pad-msg" role="status" aria-live="polite">
                    {t("common.loading")}
                  </div>
                ) : rawView ? (
                  <CodeView
                    code={contentOf(dv)}
                    format={entryFormat(dv)}
                    active={active}
                    searchTerm={searchTerm}
                    contentKey={`${tenant}::${group}::${dataId}::${dv?.id ?? ""}`}
                  />
                ) : (
                  <UnifiedDiff
                    oldText={prevEntry ? contentOf(prevEntry) : ""}
                    newText={contentOf(dv)}
                    format={entryFormat(dv)}
                    searchTerm={searchTerm}
                    active={active}
                  />
                )}
              </div>
            );
          })()
        ) : (
          <div className="pad-msg">{t("history.selectHint")}</div>
        )}
      </div>
    </div>
  );
}

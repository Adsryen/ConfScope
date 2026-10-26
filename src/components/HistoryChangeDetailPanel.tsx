// 操作历史详情里的「本次改动」：把执行记录还原成逐项可读的写前/写后差异（轮75，只读）。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../i18n";
import type { ApplyPlan, ApplyPlanAction } from "../lib/applyPlan";
import { buildHistoryChangeDetail, type HistoryChangeDetailItem, type HistoryChangeState } from "../lib/historyChangeDetail";
import type { OperationRecord } from "../store/operationHistory";
import UnifiedDiff from "./UnifiedDiff";

interface Props {
  record: OperationRecord;
  /** 计划读取器由调用方注入：面板不自己决定「计划存哪儿」，测试也能直接喂一份计划。 */
  getPlan: (id: string) => ApplyPlan | null;
}

const CHANGE_STATE_LABELS: Record<HistoryChangeState, string> = {
  changed: "operationHistory.changeStateChanged",
  unchanged: "operationHistory.changeStateUnchanged",
  unknown: "operationHistory.changeStateUnknown",
};

const ACTION_LABELS: Record<ApplyPlanAction, string> = {
  create: "apply.actions.create",
  overwrite: "apply.actions.overwrite",
  delete: "apply.actions.delete",
  skip: "apply.actions.skip",
  parse_error: "apply.actions.parse_error",
};

export default function HistoryChangeDetailPanel({ record, getPlan }: Props) {
  const { t } = useTranslation();
  const detail = useMemo(
    () => buildHistoryChangeDetail(record.planId ? getPlan(record.planId) : null, record),
    [record, getPlan]
  );
  // 半截失败的记录（轮79 E4）：这份清单只覆盖真正落笔的那几条，必须自己说清楚，
  // 免得用户把「列了 2 项」读成「勾了 2 项」或「计划只有 2 项」。
  const partialFailure = record.result !== "success" && record.scopeIsWritten === true;
  const writtenScopeCount = record.appliedLocations?.length ?? 0;
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);

  // 切换记录时归零：这一节在两条记录之间复用同一批 DOM 节点，上一项的展开态与筛选
  // 不清掉就会停在别人家的现场（与详情正文滚动归零是同一条理由）。
  useEffect(() => {
    setExpandedItemId(null);
    setOnlyChanged(false);
  }, [record.id]);

  const visibleItems = onlyChanged ? detail.items.filter((item) => item.changeState === "changed") : detail.items;

  if (detail.status === "unavailable") {
    return (
      <div className="history-detail-field history-change-detail">
        <label>{t("operationHistory.changeDetailTitle")}</label>
        <div className="field-hint" role="status">
          {t(detail.reasonKey)}
        </div>
      </div>
    );
  }

  return (
    <div className="history-detail-field history-change-detail">
      <div className="data-section-head">
        <label>{t("operationHistory.changeDetailTitle")}</label>
        <span className="history-change-summary">
          {t("operationHistory.changeDetailSummary", { total: detail.items.length, changed: detail.changedCount })}
        </span>
      </div>
      {detail.items.length > 0 && (
        <label className="history-change-filter">
          <input type="checkbox" checked={onlyChanged} onChange={(event) => setOnlyChanged(event.target.checked)} />
          {t("operationHistory.changeDetailOnlyChanged")}
        </label>
      )}

      {partialFailure && (
        <div className="field-hint" role="note">
          {t("operationHistory.changeDetailPartialScope", { count: writtenScopeCount })}
        </div>
      )}

      {detail.scopeUnverified && <div className="field-hint">{t("operationHistory.changeDetailScopeUnverified")}</div>}

      {detail.items.length === 0 && <div className="field-hint">{t("operationHistory.changeDetailEmpty")}</div>}

      {visibleItems.length > 0 && (
        <ul className="history-change-list">
          {visibleItems.map((item) => (
            <HistoryChangeItemRow
              key={item.itemId}
              item={item}
              expanded={expandedItemId === item.itemId}
              onToggle={() => setExpandedItemId((current) => (current === item.itemId ? null : item.itemId))}
            />
          ))}
        </ul>
      )}

      {onlyChanged && visibleItems.length === 0 && (
        <div className="field-hint">{t("operationHistory.changeDetailNoChangedItems")}</div>
      )}
    </div>
  );
}

function HistoryChangeItemRow({
  item,
  expanded,
  onToggle,
}: {
  item: HistoryChangeDetailItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const bodyId = `history-change-body-${item.itemId}`;

  return (
    <li className={`history-change-row${expanded ? " is-expanded" : ""}`}>
      <button
        type="button"
        className="history-change-item"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
      >
        <span className={`history-change-action is-${item.action}`}>{t(ACTION_LABELS[item.action])}</span>
        <span className="history-change-label mono" title={item.label}>
          {item.label}
        </span>
        {item.manualTuned && <span className="history-change-chip">{t("operationHistory.changeDetailManualTuned")}</span>}
        <span className={`history-change-state is-${item.changeState}`}>{t(CHANGE_STATE_LABELS[item.changeState])}</span>
        <span className="history-change-caret" aria-hidden="true">
          {expanded ? "\u2303" : "\u2304"}
        </span>
      </button>

      {expanded && (
        <div className="history-change-body" id={bodyId}>
          {!item.contentKnown && (
            <div className="field-hint">{t("operationHistory.changeDetailContentMissing")}</div>
          )}
          {item.contentKnown && (
            <>
              <div className="history-change-sides">
                <span>
                  {t("operationHistory.changeDetailBefore")}：
                  {item.targetExisted ? t("operationHistory.changeDetailBeforeExists") : t("operationHistory.changeDetailBeforeMissing")}
                </span>
                <span>
                  {t("operationHistory.changeDetailAfter")}：
                  {item.action === "delete" ? t("operationHistory.changeDetailAfterDeleted") : t("operationHistory.changeDetailAfterWritten")}
                </span>
              </div>
              <UnifiedDiff oldText={item.beforeText} newText={item.afterText} format={item.format} />
            </>
          )}
        </div>
      )}
    </li>
  );
}

// 变更计划第5步的「晋级到生产」面板（轮76）。
//
// 为什么在这儿而不是操作历史：晋级是写路径的起点，用户需要它的时刻是刚在沙箱写完、
// 正盯着回读结论的那一秒，而不是三天后翻记录的时候。操作历史是审计面，
// 轮76 已经把那里的生产目标选择器和晋级按钮整块撤掉（守卫见
// tests/ux/promotionEntryStaysInApplyFlow.test.ts）。
//
// 这个面板同样不写任何东西：它只产一份 ApplyEntryPayload，交给调用方换 entry，
// 由变更计划重新跑完整五步 + dry-run。
import { useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { getConfigDocument, listNamespaces, type Namespace } from "../api/nacos";
import type { ApplyEntryPayload } from "../lib/applyEntry";
import {
  buildPromotionEntryFromVerification,
  findVerificationForRecord,
  isProductionMarkedConnection,
  promotionTargetCandidates,
  promotionTargetNamespace,
  recordSandboxVerification,
} from "../lib/applyFollowup";
import { normalizeNamespace } from "../lib/configChangeBus";
import { errorText } from "../lib/errorText";
import { formatDateTime } from "../lib/formatDateTime";
import { reportError } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import { getApplyPlan } from "../store/applyPlans";
import { loadApplyVerifications, saveApplyVerification } from "../store/applyVerifications";
import type { Connection } from "../store/connections";
import type { OperationRecord } from "../store/operationHistory";
import InlineError from "./InlineError";
import Select from "./Select";

/**
 * 「沿用沙箱那一个命名空间」的哨兵值，不能用空串代替：
 * Nacos 的公共空间在接口里就是空 tenant，空串一旦被当成「没选」，
 * 用户点 public 就等于什么都没点（轮76 S31）。
 */
const INHERIT_SANDBOX_NAMESPACE = "__inherit-sandbox-namespace__";

interface Props {
  /** 本次执行写进操作历史的记录。验证状态戳与晋级的范围都从它出发。 */
  record: OperationRecord;
  connections: Connection[];
  /** 写后回读是否全部确认（回读有未确认项时标记验证与晋级都灰掉）。 */
  readbackConfirmed: boolean;
  /** 未确认的项数，只用来把原因写清楚。 */
  readbackUnconfirmedCount: number;
  onStartApply: (payload: ApplyEntryPayload) => void;
}

export default function PostApplyPromotionPanel({
  record,
  connections,
  readbackConfirmed,
  readbackUnconfirmedCount,
  onStartApply,
}: Props) {
  const { t } = useTranslation();
  const [verifications, setVerifications] = useState(() => loadApplyVerifications());
  const [targetId, setTargetId] = useState("");
  // 生产侧命名空间："" = 沿用沙箱那一个。以前没有这一栏，晋级把沙箱的 namespace id
  // 原样盖到生产集群上——而命名空间 id 是每套集群各发各的（MSE 是 36 位 UUID），
  // 真机 S31 量出来的后果是计划只会报「新建」，写进一个没人读的租户。
  const [namespaceChoice, setNamespaceChoice] = useState(INHERIT_SANDBOX_NAMESPACE);
  const [namespaces, setNamespaces] = useState<Namespace[]>([]);
  const [namespaceState, setNamespaceState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [busy, setBusy] = useState<"verify" | "promote" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const verification = findVerificationForRecord(verifications, record);
  const candidates = promotionTargetCandidates(connections, record, verification);
  const selectedTarget = candidates.find((conn) => conn.id === targetId) ?? candidates[0] ?? null;
  const selectedTargetId = selectedTarget?.id ?? "";
  // 换一条目标连接就等于换一套集群：上一套集群里挑的 namespace id 在这里毫无意义，
  // 所以选择与候选列表一起归零，回到「沿用沙箱那一个」，命名空间也重拉一遍。
  useEffect(() => {
    setNamespaceChoice(INHERIT_SANDBOX_NAMESPACE);
    setNamespaces([]);
    if (!selectedTargetId) {
      setNamespaceState("idle");
      return;
    }
    const connection = connections.find((conn) => conn.id === selectedTargetId);
    if (!connection) {
      setNamespaceState("idle");
      return;
    }
    let alive = true;
    setNamespaceState("loading");
    listNamespaces(connection)
      .then((items) => {
        if (!alive) return;
        setNamespaces(items);
        setNamespaceState("ready");
      })
      .catch(() => {
        // 列不出来不拦晋级：仍然按沙箱那个命名空间走，但把这句话说明白，
        // 别让人以为这一栏是空的因为「没有别的可选」。
        if (!alive) return;
        setNamespaces([]);
        setNamespaceState("error");
      });
    return () => {
      alive = false;
    };
  }, [selectedTargetId, connections]);
  const sandboxNamespace = promotionTargetNamespace(record, verification);
  const effectiveNamespace =
    namespaceChoice === INHERIT_SANDBOX_NAMESPACE ? sandboxNamespace : namespaceChoice;
  // 命名空间 id 对不上就是「新建」而不是「覆盖」，而 public 在接口里既写作 "" 也写作 "public"，
  // 所以这一层的比对口径必须和全站那份 normalizeNamespace 一致（lib/configChangeBus）。
  const namespaceExistsOnTarget = namespaces.some(
    (item) => normalizeNamespace(item.namespace) === normalizeNamespace(effectiveNamespace)
  );
  // 选中那条连接的名字里有没有「生产」这一档的标记：没有就直接说出来，
  // 这一栏叫 Production target，默认停在 Dev 上而不提示，用户就会以为晋级的是 Dev。
  const selectedTargetIsProduction = selectedTarget
    ? isProductionMarkedConnection(selectedTarget, effectiveNamespace)
    : false;
  // 回读没确认完就别自称「验证通过」：沙箱自己是不是真落到那份值都还没结论，
  // 在此基础上标记的指纹只会把假象带到生产。
  const canVerify = readbackConfirmed && busy === null;
  const blockedReason = readbackConfirmed
    ? ""
    : t("apply.promoteBlockedByUnconfirmed", { count: readbackUnconfirmedCount });
  const promoteReasons: string[] = [];
  if (!canVerify) promoteReasons.push(blockedReason);
  if (!verification) promoteReasons.push(t("apply.promoteRequiresVerification"));
  if (!selectedTarget) promoteReasons.push(t("apply.promoteNoTarget"));
  if (busy) promoteReasons.push(t("apply.promoteBusyGuard"));

  const markVerified = async () => {
    setBusy("verify");
    setError(null);
    try {
      const result = await recordSandboxVerification(record, {
        connections,
        getApplyPlan,
        getConfigDocument,
        saveVerification: saveApplyVerification,
      });
      if (!result.ok) {
        setError(result.detail);
        return;
      }
      setVerifications(loadApplyVerifications());
      toast(t("apply.promoteMarked"), "success");
    } catch (e) {
      const message = errorText(e);
      setError(message);
      reportError({ title: t("apply.promoteFailed"), source: record.dataId, message, detail: message });
    } finally {
      setBusy(null);
    }
  };

  const promote = async () => {
    if (!verification || !selectedTarget) return;
    setBusy("promote");
    setError(null);
    try {
      const result = await buildPromotionEntryFromVerification(
        record,
        verification,
        selectedTarget,
        {
          connections,
          getApplyPlan,
          getConfigDocument,
        },
        { targetNamespace: effectiveNamespace }
      );
      if (!result.ok) {
        setError(result.detail);
        return;
      }
      onStartApply(result.entry);
    } catch (e) {
      const message = errorText(e);
      setError(message);
      reportError({ title: t("apply.promoteFailed"), source: record.dataId, message, detail: message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="apply-promote-panel">
      <div className="apply-promote-head">
        <strong>{t("apply.promotePanelTitle")}</strong>
        <span className="field-hint">{t("apply.promotePanelIntro")}</span>
      </div>
      <ol className="apply-promote-steps">
        <li>
          <span className="apply-promote-step-label">{t("apply.promoteStepReadback")}</span>
          <span className={`apply-promote-step-value ${readbackConfirmed ? "is-ok" : "is-warn"}`}>
            {readbackConfirmed
              ? t("apply.promoteReadbackConfirmed")
              : t("apply.promoteReadbackUnconfirmed", { count: readbackUnconfirmedCount })}
          </span>
        </li>
        <li>
          <span className="apply-promote-step-label">{t("apply.promoteStepVerification")}</span>
          <span className={`apply-promote-step-value ${verification ? "is-ok" : ""}`}>
            {verification
              ? t("apply.promoteVerificationVerified", {
                  target: verification.sandboxConnectionName,
                  namespace: verification.sandboxNamespace,
                  time: formatDateTime(verification.verifiedAt),
                })
              : t("apply.promoteVerificationUnverified")}
          </span>
        </li>
      </ol>
      <div className="apply-promote-actions">
        <span className="btn-guard" title={canVerify ? undefined : blockedReason || promoteReasons.join("\n")}>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => void markVerified()}
            disabled={!canVerify}
            aria-disabled={!canVerify}
          >
            {busy === "verify"
              ? t("apply.promoteMarking")
              : verification
                ? t("apply.promoteRemarkVerified")
                : t("apply.promoteMarkVerified")}
          </button>
        </span>
        {/* 生产目标用全站自绘下拉（Select）：原生 select 的弹层跟随系统主题，深色界面里会闪一块白。 */}
        <label className="field apply-promote-target">
          <span>{t("apply.promoteTargetLabel")}</span>
          <Select
            className="wide"
            value={selectedTarget?.id ?? ""}
            options={candidates.map((conn) => ({ value: conn.id, label: conn.name }))}
            onChange={setTargetId}
            placeholder={candidates.length === 0 ? t("apply.promoteNoTarget") : undefined}
          />
          {selectedTarget && !selectedTargetIsProduction && (
            <span className="apply-promote-target-note">
              {t("apply.promoteTargetNoProductionMarker", { target: selectedTarget.name })}
            </span>
          )}
        </label>
        {/* 命名空间单独一栏：晋级写进哪一套租户必须是用户点出来的事实，不能是代码顺手带过去的默认值。 */}
        <label className="field apply-promote-target apply-promote-namespace">
          <span>{t("apply.promoteNamespaceLabel")}</span>
          <Select
            className="wide"
            value={namespaceChoice}
            options={[
              {
                value: INHERIT_SANDBOX_NAMESPACE,
                label: t("apply.promoteNamespaceInherit", { namespace: normalizeNamespace(sandboxNamespace) })
              },
              ...namespaces
                .filter((item) => normalizeNamespace(item.namespace) !== normalizeNamespace(sandboxNamespace))
                .map((item) => ({
                  value: item.namespace,
                  // 公共空间的 id 是空串，括注上去就成了「public ()」这种脏读数。
                  label: item.namespace && item.namespaceShowName && item.namespaceShowName !== item.namespace
                    ? `${item.namespaceShowName} (${item.namespace})`
                    : item.namespaceShowName || normalizeNamespace(item.namespace),
                })),
            ]}
            onChange={setNamespaceChoice}
            disabled={namespaceState === "loading"}
            title={effectiveNamespace}
          />
          {namespaceState === "loading" && (
            <span className="field-hint">{t("apply.promoteNamespaceLoading")}</span>
          )}
          {namespaceState === "error" && (
            <span className="apply-promote-namespace-note">
              {t("apply.promoteNamespaceLoadFailed", { target: selectedTarget?.name ?? "" })}
            </span>
          )}
          {namespaceState === "ready" && !namespaceExistsOnTarget && (
            <span className="apply-promote-namespace-note">
              {t("apply.promoteNamespaceMissing", {
                namespace: normalizeNamespace(effectiveNamespace),
                target: selectedTarget?.name ?? "",
              })}
            </span>
          )}
        </label>
        <span className="btn-guard" title={promoteReasons.length ? promoteReasons.join("\n") : undefined}>
          <button
            className="btn btn-primary btn-sm"
            type="button"
            onClick={() => void promote()}
            disabled={promoteReasons.length > 0}
            aria-disabled={promoteReasons.length > 0}
          >
            {busy === "promote" ? t("apply.promoteBuilding") : t("apply.promoteAction")}
          </button>
        </span>
      </div>
      <div className="field-hint">{t("apply.promoteDryRunPromise")}</div>
      {/* 复制按钮走 InlineError 的默认标签：站点不再攒私有文案（轮13 波28 / R48）。 */}
      {error && <InlineError title={t("apply.promoteFailed")} message={error} />}
    </div>
  );
}

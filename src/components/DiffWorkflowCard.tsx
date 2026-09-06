import { useTranslation } from "../i18n";

export type WorkflowStepId = "choose" | "compare" | "plan" | "execute" | "verify";
export type WorkflowStepStatus = "completed" | "current" | "upcoming";

export const WORKFLOW_STEP_IDS: WorkflowStepId[] = ["choose", "compare", "plan", "execute", "verify"];

interface Props {
  currentStep: WorkflowStepId;
  completed?: boolean;
  /** 步骤点击（导航动作由父组件实现）；不传时保持纯指示 */
  onStepClick?: (step: WorkflowStepId) => void;
  /** 父组件裁决该步是否锁定（前进入口约束） */
  isStepLocked?: (step: WorkflowStepId) => boolean;
  /** 锁定原因（hover 气泡） */
  lockReason?: (step: WorkflowStepId) => string;
}

/**
 * 顶栏极简工作流 stepper：五步 + 当前高亮，可点击导航。
 * - 回退：点击任意更早的步骤，回退到该环节（进度保留）。
 * - 前进：只允许点击相邻下一步（不跳节点），且入口约束满足（父组件裁决）。
 * - 步骤说明与锁定原因在 hover 气泡（title）中展示。
 */
export default function DiffWorkflowCard({ currentStep, completed = false, onStepClick, isStepLocked, lockReason }: Props) {
  const { t } = useTranslation();
  const currentIndex = WORKFLOW_STEP_IDS.indexOf(currentStep);
  const stepLabel = (step: WorkflowStepId) => t(`diff.workflowStep${WORKFLOW_STEP_IDS.indexOf(step) + 1}`);
  const stepDetail = (step: WorkflowStepId) => t(`diff.workflowStep${WORKFLOW_STEP_IDS.indexOf(step) + 1}Detail`);
  const stepStatus = (step: WorkflowStepId): WorkflowStepStatus => {
    if (completed) return "completed";
    const index = WORKFLOW_STEP_IDS.indexOf(step);
    if (index < currentIndex) return "completed";
    if (index === currentIndex) return "current";
    return "upcoming";
  };
  const navigate = Boolean(onStepClick);
  const stepClickable = (step: WorkflowStepId, status: WorkflowStepStatus, index: number): boolean => {
    if (!navigate) return false;
    if (status === "current") return false;
    if (status === "completed") return true; // 回退到任意更早步骤
    // upcoming：只允许相邻下一步，且不锁定
    if (index !== currentIndex + 1) return false;
    return !isStepLocked?.(step);
  };
  const stepTitle = (step: WorkflowStepId, status: WorkflowStepStatus, index: number): string => {
    if (stepClickable(step, status, index)) {
      if (status === "completed") return t("diff.workflowBackTo", { step: stepLabel(step) });
      return `${stepLabel(step)}: ${stepDetail(step)}`;
    }
    if (status === "current") return `${stepLabel(step)}: ${stepDetail(step)}`;
    return lockReason?.(step) ?? stepLabel(step);
  };

  return (
    <nav className="diff-workflow-card" aria-label={t("diff.workflowTitle")}>
      <ol className="diff-workflow-steps">
        {WORKFLOW_STEP_IDS.map((step, index) => {
          const status = stepStatus(step);
          const clickable = stepClickable(step, status, index);
          const inner = (
            <>
              <span className="diff-workflow-step-mark" aria-hidden="true">
                {status === "completed" ? "✓" : index + 1}
              </span>
              <span className="diff-workflow-step-label">{stepLabel(step)}</span>
            </>
          );
          return (
            <li
              key={step}
              className={`diff-workflow-step ${status}${clickable ? " clickable" : ""}${!clickable && status === "upcoming" ? " locked" : ""}`}
              title={stepTitle(step, status, index)}
              aria-current={status === "current" ? "step" : undefined}
            >
              {clickable ? (
                <button
                  type="button"
                  className="diff-workflow-step-btn"
                  aria-label={`${t("diff.workflowStepAria")}: ${stepLabel(step)}`}
                  onClick={() => onStepClick?.(step)}
                >
                  {inner}
                </button>
              ) : (
                <span className="diff-workflow-step-btn">
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

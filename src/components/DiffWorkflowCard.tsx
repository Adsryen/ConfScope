import { useTranslation } from "../i18n";

export type WorkflowStepId = "choose" | "compare" | "plan" | "execute" | "verify";
export type WorkflowStepStatus = "completed" | "current" | "upcoming";

export const WORKFLOW_STEP_IDS: WorkflowStepId[] = ["choose", "compare", "plan", "execute", "verify"];

interface Props {
  currentStep: WorkflowStepId;
  completed?: boolean;
  /** 步骤点击（仅回退）；不传时保持纯指示 */
  onStepClick?: (step: WorkflowStepId) => void;
}

/**
 * 顶栏极简工作流 stepper：五步 + 当前高亮。
 * - 仅回退：任意更早（已完成）的步骤可点击，回退到该环节（进度保留）。
 * - 不提供前进点击：前进到下一步依赖用户在页面上做的选择（勾选文件、选择变更等），
 *   程序无法代用户决定，前进必须走页面内的操作按钮（加载并对比 / 进入变更计划 / 执行变更）。
 * - 每步 hover 气泡（title）展示「步骤名: 步骤说明」。
 */
export default function DiffWorkflowCard({ currentStep, completed = false, onStepClick }: Props) {
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
  const stepTitle = (step: WorkflowStepId, status: WorkflowStepStatus): string => {
    if (status === "completed" && onStepClick) return t("diff.workflowBackTo", { step: stepLabel(step) });
    return `${stepLabel(step)}: ${stepDetail(step)}`;
  };

  return (
    <nav className="diff-workflow-card" aria-label={t("diff.workflowTitle")}>
      <ol className="diff-workflow-steps">
        {WORKFLOW_STEP_IDS.map((step, index) => {
          const status = stepStatus(step);
          const clickable = Boolean(onStepClick) && status === "completed";
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
              title={stepTitle(step, status)}
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

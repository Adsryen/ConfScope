import { useTranslation } from "../i18n";

export type WorkflowStepId = "choose" | "compare" | "plan" | "execute" | "verify";
export type WorkflowStepStatus = "completed" | "current" | "upcoming";

export const WORKFLOW_STEP_IDS: WorkflowStepId[] = ["choose", "compare", "plan", "execute", "verify"];

interface Props {
  currentStep: WorkflowStepId;
  completed?: boolean;
}

/**
 * 极简工作流进度条（顶栏内联）：只保留五步与当前高亮。
 * - 步骤说明放在 hover 气泡（title）里，不再常驻 detail 框。
 * - 进度指示不可点击，避免与 tab 点击产生语义混淆。
 */
export default function DiffWorkflowCard({ currentStep, completed = false }: Props) {
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

  return (
    <nav className="diff-workflow-card" aria-label={t("diff.workflowTitle")}>
      <ol className="diff-workflow-steps">
        {WORKFLOW_STEP_IDS.map((step, index) => {
          const status = stepStatus(step);
          return (
            <li
              key={step}
              className={`diff-workflow-step ${status}`}
              title={`${stepLabel(step)}: ${stepDetail(step)}`}
              aria-current={status === "current" ? "step" : undefined}
            >
              <span className="diff-workflow-step-mark" aria-hidden="true">
                {status === "completed" ? "✓" : index + 1}
              </span>
              <span className="diff-workflow-step-label">{stepLabel(step)}</span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

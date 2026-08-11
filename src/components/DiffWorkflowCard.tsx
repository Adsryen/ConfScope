import { useTranslation } from "../i18n";

export type WorkflowStepId = "choose" | "compare" | "plan" | "execute" | "verify";
export type WorkflowStepStatus = "completed" | "current" | "upcoming";

export const WORKFLOW_STEP_IDS: WorkflowStepId[] = ["choose", "compare", "plan", "execute", "verify"];

interface Props {
  currentStep: WorkflowStepId;
  completed?: boolean;
  detailStep?: WorkflowStepId | null;
  onDetailStepChange?: (step: WorkflowStepId) => void;
}

export default function DiffWorkflowCard({ currentStep, completed = false, detailStep, onDetailStepChange }: Props) {
  const { t } = useTranslation();
  const currentIndex = WORKFLOW_STEP_IDS.indexOf(currentStep);
  const focusStep = detailStep ?? currentStep;
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
    <aside className="diff-workflow-card" aria-label={t("diff.workflowTitle")}>
      <div className="diff-workflow-head">
        <div className="diff-workflow-title-wrap">
          <span className="diff-workflow-title">{t("diff.workflowTitle")}</span>
          <span className="diff-workflow-current">
            {completed ? t("diff.workflowComplete") : t("diff.workflowCurrent", { step: stepLabel(currentStep) })}
          </span>
        </div>
        <span className="diff-workflow-safety">{t("diff.workflowSafety")}</span>
      </div>
      <ol className="diff-workflow-steps">
        {WORKFLOW_STEP_IDS.map((step) => {
          const status = stepStatus(step);
          const label = stepLabel(step);
          return (
            <li className={`diff-workflow-step ${status}${focusStep === step ? " focused" : ""}`} key={step}>
              <button type="button" aria-current={status === "current" ? "step" : undefined} onClick={() => onDetailStepChange?.(step)}>
                <span className="diff-workflow-step-status">{t(`diff.workflowStatus.${status}`)}</span>
                <span className="diff-workflow-step-label">{label}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <div className="diff-workflow-detail">
        <span className="diff-workflow-detail-title">{t("diff.workflowDetailTitle", { step: stepLabel(focusStep) })}</span>
        <span>{stepDetail(focusStep)}</span>
      </div>
      <div className="diff-workflow-note">{t("diff.workflowSandbox")}</div>
    </aside>
  );
}

import CopyButton from "./CopyButton";
import { useTranslation } from "../i18n";

export type TraceStepStatus = "ok" | "checked" | "error" | "pending" | "skipped";

export interface TraceStep {
  name: string;
  status: TraceStepStatus;
  detail?: string;
  latencyMs?: number;
}

export interface TestTrace {
  ok: boolean;
  title: string;
  summary: string;
  steps: TraceStep[];
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

function statusLabel(status: TraceStepStatus, t: Translate) {
  if (status === "ok") return t("connection.traceStatusOk");
  if (status === "checked") return t("connection.traceStatusChecked");
  if (status === "error") return t("connection.traceStatusError");
  if (status === "pending") return t("connection.traceStatusPending");
  return t("connection.traceStatusSkipped");
}

function stepLine(step: TraceStep, t: Translate) {
  const latency = typeof step.latencyMs === "number" ? ` (${step.latencyMs} ms)` : "";
  const detail = step.detail ? `\n  ${step.detail}` : "";
  return `[${statusLabel(step.status, t)}] ${step.name}${latency}${detail}`;
}

export function traceToText(trace: TestTrace, t: Translate): string {
  return [`${trace.title}: ${trace.summary}`, ...trace.steps.map((step) => stepLine(step, t))].join("\n");
}

export default function TestTraceView({ trace }: { trace: TestTrace }) {
  const { t } = useTranslation();
  return (
    <div className={`test-trace ${trace.ok ? "ok" : "err"}`}>
      <div className="test-trace-head">
        <div>
          <div className="test-trace-title">{trace.title}</div>
          <div className="test-trace-summary">{trace.summary}</div>
        </div>
        <CopyButton text={traceToText(trace, t)} label={t("connection.copyTrace")} />
      </div>
      <div className="test-trace-steps">
        {trace.steps.map((step, index) => (
          <div key={`${step.name}:${index}`} className={`test-trace-step ${step.status}`}>
            <span className="trace-dot" />
            <div className="trace-main">
              <div className="trace-row">
                <span className="trace-name">{step.name}</span>
                <span className="trace-status">{statusLabel(step.status, t)}</span>
                {typeof step.latencyMs === "number" && <span className="trace-latency">{step.latencyMs} ms</span>}
              </div>
              {step.detail && <div className="trace-detail">{step.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

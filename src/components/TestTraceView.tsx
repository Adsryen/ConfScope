import CopyButton from "./CopyButton";

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

function statusLabel(status: TraceStepStatus) {
  if (status === "ok") return "成功";
  if (status === "checked") return "已检查";
  if (status === "error") return "失败";
  if (status === "pending") return "测试中";
  return "跳过";
}

function stepLine(step: TraceStep) {
  const latency = typeof step.latencyMs === "number" ? ` (${step.latencyMs} ms)` : "";
  const detail = step.detail ? `\n  ${step.detail}` : "";
  return `[${statusLabel(step.status)}] ${step.name}${latency}${detail}`;
}

export function traceToText(trace: TestTrace): string {
  return [`${trace.title}: ${trace.summary}`, ...trace.steps.map(stepLine)].join("\n");
}

export default function TestTraceView({ trace }: { trace: TestTrace }) {
  return (
    <div className={`test-trace ${trace.ok ? "ok" : "err"}`}>
      <div className="test-trace-head">
        <div>
          <div className="test-trace-title">{trace.title}</div>
          <div className="test-trace-summary">{trace.summary}</div>
        </div>
        <CopyButton text={traceToText(trace)} label="复制链路" />
      </div>
      <div className="test-trace-steps">
        {trace.steps.map((step, index) => (
          <div key={`${step.name}:${index}`} className={`test-trace-step ${step.status}`}>
            <span className="trace-dot" />
            <div className="trace-main">
              <div className="trace-row">
                <span className="trace-name">{step.name}</span>
                <span className="trace-status">{statusLabel(step.status)}</span>
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

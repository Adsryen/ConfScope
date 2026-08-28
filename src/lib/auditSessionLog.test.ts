// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  createAuditSession,
  auditSessionEvent,
  endAuditSession,
  listAuditSessions,
  sessionsFromJsonlLines,
  appendAuditEvent,
  __resetAuditSessionsForTest,
} from "./auditSessionLog";

interface AuditBridgeWindow {
  __auditBridge?: { appendAuditEvent: (payload: unknown) => void };
}

function withBridgeCapture() {
  const calls: unknown[] = [];
  const win = window as AuditBridgeWindow;
  win.__auditBridge = { appendAuditEvent: (payload) => calls.push(payload) };
  return calls;
}

describe("auditSessionLog", () => {
  beforeEach(() => {
    (window as AuditBridgeWindow).__auditBridge = undefined;
    __resetAuditSessionsForTest();
  });

  it("records session lifecycle events to the bridge with sessionId", () => {
    const calls = withBridgeCapture();
    const id = createAuditSession("compare");
    auditSessionEvent(id, { kind: "compare_start", mode: "text" });
    auditSessionEvent(id, { kind: "compare_result", result: "success", additions: 3, deletions: 1 });
    endAuditSession(id, "success");

    const kinds = calls.map((c) => (c as { kind: string }).kind);
    expect(kinds).toEqual(["session_start", "compare_start", "compare_result", "session_end"]);
    for (const call of calls) {
      expect((call as { sessionId: string }).sessionId).toBe(id);
      expect((call as { schema: number }).schema).toBe(1);
    }
    expect(listAuditSessions()).toHaveLength(1);
    expect(listAuditSessions()[0].status).toBe("success");
  });

  it("marks failure session when an error event is recorded", () => {
    withBridgeCapture();
    const id = createAuditSession("apply");
    auditSessionEvent(id, { kind: "apply_error", result: "failure", error: "boom" });
    endAuditSession(id, "failure", "boom");
    expect(listAuditSessions()[0].status).toBe("failure");
  });

  it("appendAuditEvent is a no-op without bridge and never throws", () => {
    expect(() => appendAuditEvent({ kind: "compare_start" })).not.toThrow();
    const calls = withBridgeCapture();
    appendAuditEvent({ kind: "compare_start" });
    expect(calls).toHaveLength(1);
  });

  it("sessionsFromJsonlLines groups events by sessionId and skips malformed lines", () => {
    const lines = [
      '{"schema":1,"ts":"2026-08-28T10:00:00Z","kind":"session_start","sessionId":"compare-x","scope":"compare"}',
      "not json",
      '{"schema":1,"ts":"2026-08-28T10:00:01Z","kind":"compare_result","sessionId":"compare-x","result":"success"}',
      '{"schema":1,"ts":"2026-08-28T10:00:02Z","kind":"session_end","sessionId":"compare-x","result":"success"}',
      '{"schema":1,"ts":"2026-08-28T10:00:03Z","kind":"session_start","sessionId":"apply-y","scope":"apply"}',
    ];
    const grouped = sessionsFromJsonlLines(lines);
    expect(grouped.get("compare-x")).toHaveLength(3);
    expect(grouped.get("apply-y")).toHaveLength(1);
    expect(grouped.has("not json")).toBe(false);
  });

  it("does not double-record when session is unknown (refresh case) but still persists", () => {
    const calls = withBridgeCapture();
    auditSessionEvent("compare-unknown", { kind: "compare_start" });
    expect(calls).toHaveLength(1);
    expect(listAuditSessions()).toHaveLength(0);
  });
});


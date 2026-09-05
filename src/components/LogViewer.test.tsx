// @vitest-environment jsdom
import { describe, it, expect, beforeEach, type Mock, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import LogViewer from "./LogViewer";

function renderViewer() {
  return render(<I18nProvider><LogViewer /></I18nProvider>);
}
import {
  createAuditSession,
  auditSessionEvent,
  endAuditSession,
  __resetAuditSessionsForTest,
} from "../lib/auditSessionLog";

vi.mock("../../wailsjs/go/app/App", () => ({
  ReadAuditLogLines: vi.fn().mockResolvedValue([]),
  GetAppInfo: vi.fn().mockResolvedValue({ name: "ConfScope", version: "1.8.0", updateSources: [] }),
}));

import { ReadAuditLogLines } from "../../wailsjs/go/app/App";

describe("LogViewer", () => {
  beforeEach(() => {
    localStorage.setItem("locale", "zh-CN");
    __resetAuditSessionsForTest();
    (ReadAuditLogLines as unknown as Mock).mockClear();
    (ReadAuditLogLines as unknown as Mock).mockResolvedValue([]);
  });

  it("shows live compare session with its event stream and jsonl copy", async () => {
    const id = createAuditSession("compare");
    auditSessionEvent(id, { kind: "compare_start", mode: "text", left: "L", right: "R" });
    auditSessionEvent(id, { kind: "compare_result", result: "success", additions: 2, deletions: 1, identical: false });
    endAuditSession(id, "success");

    renderViewer();

    expect((await screen.findAllByText(/compare-/)).length).toBeGreaterThanOrEqual(2);
    // 事件行按 JSONL 展示
    await waitFor(() => {
      const json = screen.getByText(/"kind":"compare_result"/);
      expect(json).toBeTruthy();
    });
    // 复制按钮存在
    const copyBtn = document.querySelector(".log-detail-header .btn-ghost");
    expect(copyBtn).toBeTruthy();
  });

  it("renders persisted sessions grouped by sessionId when ReadAuditLogLines returns lines", async () => {
    (ReadAuditLogLines as unknown as Mock).mockResolvedValue([
      '{"schema":1,"ts":"2026-08-28T09:00:00Z","kind":"session_start","sessionId":"apply-1","scope":"apply"}',
      '{"schema":1,"ts":"2026-08-28T09:00:01Z","kind":"apply_plan_start","sessionId":"apply-1","planId":"plan_1","dryRun":false}',
      '{"schema":1,"ts":"2026-08-28T09:00:02Z","kind":"apply_result","sessionId":"apply-1","result":"success"}',
      '{"schema":1,"ts":"2026-08-28T09:00:03Z","kind":"session_end","sessionId":"apply-1","result":"success"}',
    ]);

    renderViewer();

    await waitFor(() => {
      expect(screen.getAllByText(/apply-1/).length).toBeGreaterThan(0);
    });
    // 成功状态
    expect(screen.getAllByText("成功").length).toBeGreaterThan(0);
    // 完整事件流以 JSONL 展示
    await waitFor(() => {
      expect(screen.getByText(/"kind":"apply_result"/)).toBeTruthy();
    });
  });

  it("falls back to live-only when ReadAuditLogLines rejects (web manual bridge mode)", async () => {
    (ReadAuditLogLines as unknown as Mock).mockRejectedValue(new Error("no native binding"));
    const id = createAuditSession("audit");
    auditSessionEvent(id, { kind: "audit_run_result", result: "success" });
    endAuditSession(id, "success");

    renderViewer();
    await waitFor(() => {
      expect(screen.getAllByText(/audit-/).length).toBeGreaterThan(0);
    });
  });

  it("filters sessions by kind", async () => {
    const cId = createAuditSession("compare");
    endAuditSession(cId, "success");
    const aId = createAuditSession("audit");
    endAuditSession(aId, "success");

    const { container } = renderViewer();
    await waitFor(() => {
      expect(screen.getAllByText(/compare-/).length).toBeGreaterThan(0);
    });
    // kind 按钮文案随 locale 变化，按当前 locale 解析
    const { currentLocale, getTranslation } = await import("../locales");
    const label = getTranslation(currentLocale(), "logViewer.kindCompare");
    const compareBtn = screen.getAllByRole("button").find((el) => el.textContent?.trim() === label);
    expect(compareBtn).toBeTruthy();
    compareBtn?.click();
    // 点击后再点击取消过滤（toggle 行为），最终恢复全部
    compareBtn?.click();
    await waitFor(() => {
      const items = container.querySelectorAll(".data-list .task-item-name");
      expect(Array.from(items).map((el) => el.textContent?.trim()).sort()).toEqual([aId, cId].sort());
    });
    expect(container).toBeTruthy();
  });
});

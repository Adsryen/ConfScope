// @vitest-environment jsdom
import { describe, it, expect, beforeEach, type Mock, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "../test/react";
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
    // 轮142 B3：筛选按钮从「对比」变成「对比 2」——计数才是要看的东西，
    // 按钮文案因此只按前缀匹配，别再要求整串相等。
    const compareBtn = screen.getAllByRole("button").find((el) => (el.textContent ?? "").trim().startsWith(label));
    expect(compareBtn).toBeTruthy();
    compareBtn?.click();
    // 点击后再点击取消过滤（toggle 行为），最终恢复全部
    compareBtn?.click();
    await waitFor(() => {
      // 轮142 B1：行的主标题换成人可读摘要，会话 id 退到 .log-item-id——
      // 这条用例要钉的是「筛选后剩下的就是那两条会话」，认 id 才是稳定身份。
      const items = container.querySelectorAll(".data-list .log-item-id");
      expect(Array.from(items).map((el) => el.textContent?.trim()).sort()).toEqual([aId, cId].sort());
    });
    expect(container).toBeTruthy();
  });

  it("快照行键盘可达：三件套齐了，Enter 与空格能换选中项（R61）", async () => {
    const aId = createAuditSession("compare");
    const cId = createAuditSession("audit");
    endAuditSession(aId, "success");
    endAuditSession(cId, "success");

    const { container } = renderViewer();
    await waitFor(() => {
      expect(container.querySelectorAll(".data-list-item").length).toBe(2);
    });
    const rows = Array.from(container.querySelectorAll(".data-list-item"));

    expect(rows[0]).toHaveAttribute("role", "button");
    expect(rows[0]).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(rows[0], { key: "Enter" });
    expect(rows[0]).toHaveAttribute("aria-current", "true");

    fireEvent.keyDown(rows[1], { key: " " });
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(rows[0]).not.toHaveAttribute("aria-current");
  });
});

describe("LogViewer 切换会话滚动复位（波29 R49）", () => {
  beforeEach(() => {
    localStorage.setItem("locale", "zh-CN");
    __resetAuditSessionsForTest();
    (ReadAuditLogLines as unknown as Mock).mockResolvedValue([]);
  });

  /** jsdom 没有布局引擎，scrollTop 恒为 0；挂可读写的实现才能断言"被重置"。 */
  function stubScroll(el: HTMLElement) {
    const offsets = { top: 0 };
    Object.defineProperty(el, "scrollTop", {
      configurable: true,
      get: () => offsets.top,
      set: (value: number) => {
        offsets.top = value;
      },
    });
    return offsets;
  }

  function clickSession(container: HTMLElement, id: string) {
    const rows = Array.from(container.querySelectorAll<HTMLElement>(".data-list .data-list-item"));
    const row = rows.find((el) => el.textContent?.includes(id));
    expect(row, `找不到会话 ${id}`).toBeTruthy();
    fireEvent.click(row as HTMLElement);
  }

  it("切换会话时原文块与事件载荷块都回到顶部", async () => {
    const older = createAuditSession("compare");
    auditSessionEvent(older, { kind: "compare_start", mode: "text", left: "L1", right: "R1" });
    endAuditSession(older, "success");
    const newer = createAuditSession("compare");
    auditSessionEvent(newer, { kind: "compare_start", mode: "text", left: "L2", right: "R2" });
    endAuditSession(newer, "success");

    const { container } = renderViewer();
    await waitFor(() => expect(container.querySelectorAll(".data-list-item").length).toBe(2));
    clickSession(container, newer);
    await waitFor(() => expect(container.querySelector(".log-event-payload")).toBeTruthy());

    const jsonl = stubScroll(container.querySelector(".log-jsonl") as HTMLElement);
    const payload = stubScroll(container.querySelector(".log-event-payload") as HTMLElement);
    jsonl.top = 140;
    payload.top = 90;

    clickSession(container, older);

    await waitFor(() => expect(container.querySelector(".log-jsonl")?.textContent).toContain("L1"));
    expect(jsonl.top).toBe(0);
    expect((container.querySelector(".log-event-payload") as HTMLElement).textContent).toContain("L1");
    expect(payload.top).toBe(0);
  });
});

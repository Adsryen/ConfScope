/**
 * @vitest-environment jsdom
 */
/**
 * 根错误边界的四条契约（轮95 R3 / R4）。
 *
 * 为什么要专门测它：轮94 真机那张白屏里，`document.getElementById("root").children.length === 0`、
 * `document.body.innerText === ""` —— 没有提示、没有按钮、连「出事了」都没告诉用户。
 * 这种缺陷不碰任何功能路径，功能用例全绿，只有把「渲染期真的抛一下」喂给边界才测得出来。
 * 四条契约对应 R3 的三条硬要求 + R4 的留痕：看得见（有内容、有出口）、读得完（不截断）、
 * 抄得走（复制到的文字与登记的那份一字不差）、说得出（消息中心 + 审计各留一条）。
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { translate } from "../locales";
import AppErrorBoundary, { buildCrashDiagnostics } from "./AppErrorBoundary";

// 消息中心：换成可控壳子，才断得出「这一次事故到底登记了什么、有没有抢即时播报通道」。
const centerMocks = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("../lib/errorCenter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/errorCenter")>();
  return { ...actual, reportError: centerMocks.reportError };
});

// 审计留痕同理：真实现要碰 __auditBridge，jsdom 里只会静默失败，测不到「有没有登记」。
const auditMocks = vi.hoisted(() => ({ appendAuditEvent: vi.fn() }));
vi.mock("../lib/auditSession", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auditSession")>();
  return { ...actual, appendAuditEvent: auditMocks.appendAuditEvent };
});

// 复制走全站唯一的 copyText。真实现在 jsdom 里要动 execCommand，
// 换成壳子才测得出「抄得走」抄走的究竟是界面那一段，还是别的东西。
const clipboardMocks = vi.hoisted(() => ({ copyText: vi.fn() }));
vi.mock("../lib/clipboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/clipboard")>();
  return { ...actual, copyText: clipboardMocks.copyText };
});

/**
 * 一段可控的调用栈。
 *
 * 最后一行 `App (src/App.tsx:694:5)` 是故意放在栈尾的：截断式实现（`slice(0, N)`）
 * 丢掉的正是这一行，而「崩在哪个页面」全靠它。用例断它还在，等于把「不截断」钉住。
 */
const BOOM_MESSAGE = "渲染到一半就炸了";
const BOOM_STACK = [`Error: ${BOOM_MESSAGE}`, "    at ReportPanel (src/components/AuditView.tsx:412:3)", "    at div (<anonymous>)", "    at App (src/App.tsx:694:5)"].join("\n");

/** 当前会不会抛。改成 null 就是「重新载入后一切正常」，用来测 remount 那条出口。 */
let boom: Error | null = null;

function Fragile({ label }: { label: string }) {
  if (boom) throw boom;
  return <div className="alive">{label}</div>;
}

/** 真应用的接法：边界在 I18nProvider 里面（兜底界面自己也要出文案、也要用 CopyButton）。 */
function Harness() {
  return (
    <I18nProvider>
      <AppErrorBoundary>
        <Fragile label="界面还在" />
      </AppErrorBoundary>
    </I18nProvider>
  );
}

function triggerCrash(): void {
  boom = new Error(BOOM_MESSAGE);
  boom.stack = BOOM_STACK;
}

/** 崩一次并返回渲染结果（React 会把被捕获的错误打到 console.error，这里静音掉）。 */
function renderCrashed() {
  triggerCrash();
  const view = render(<Harness />);
  expect(screen.getByRole("alert")).toBeInTheDocument();
  return view;
}

beforeEach(() => {
  boom = null;
  // 钉死语言：兜底文案既给中文用例读，也要证明标签真的跟着语言走（见最后一条用例）。
  localStorage.setItem("locale", "zh-CN");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  centerMocks.reportError.mockReset();
  auditMocks.appendAuditEvent.mockReset();
  clipboardMocks.copyText.mockReset().mockResolvedValue(true);
});

describe("AppErrorBoundary", () => {
  it("界面正常时不接管，children 原样渲染", () => {
    render(<Harness />);
    expect(screen.getByText("界面还在")).toBeInTheDocument();
    expect(document.querySelector(".app-crash")).toBeNull();
    expect(centerMocks.reportError).not.toHaveBeenCalled();
  });

  it("渲染期抛错降级成可读兜底：有标题、有说明、有两条出口", () => {
    renderCrashed();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(translate("crash.title"));
    // 用户最该先看到的一句：数据没被动过。不写清楚就会有人以为配置文件被程序改了。
    expect(alert.textContent).toContain("本地数据文件没有被改动");
    expect(screen.getByRole("button", { name: translate("crash.reload") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: translate("crash.copy") })).toBeInTheDocument();
    // 正控：界面没被卸载成白屏（轮94 的实测形态就是这一条为 0）
    expect(alert.textContent.length).toBeGreaterThan(80);
  });

  it("诊断文本读得完：错误名、消息、完整栈、组件栈、发生时间都在，栈尾没被截掉", () => {
    renderCrashed();
    const detail = document.querySelector(".app-crash-detail")?.textContent ?? "";
    expect(detail).toContain(`Error: ${BOOM_MESSAGE}`);
    expect(detail).toContain(BOOM_STACK);
    expect(detail).toContain(translate("crash.stackLabel"));
    expect(detail).toContain("Fragile"); // React 组件栈里出错的那个组件
    expect(detail).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO 时间
    // 栈尾那一行还在 = 没有被截断
    expect(detail).toContain("App (src/App.tsx:694:5)");
  });

  it("抄得走：复制按钮拿到的就是界面上那一段，一字不差", async () => {
    renderCrashed();
    const detail = document.querySelector(".app-crash-detail")?.textContent ?? "";
    fireEvent.click(screen.getByRole("button", { name: translate("crash.copy") }));
    await waitFor(() => expect(clipboardMocks.copyText).toHaveBeenCalled());
    const copied = clipboardMocks.copyText.mock.calls[0][0];
    expect(copied).toBe(detail);
  });

  it("重新载入只重建界面：children 回来，且这一次事故不重复登记", () => {
    renderCrashed();
    expect(centerMocks.reportError).toHaveBeenCalledTimes(1);
    boom = null;
    fireEvent.click(screen.getByRole("button", { name: translate("crash.reload") }));
    expect(screen.getByText("界面还在")).toBeInTheDocument();
    expect(document.querySelector(".app-crash")).toBeNull();
    expect(centerMocks.reportError).toHaveBeenCalledTimes(1);
  });

  it("留痕：消息中心那条是系统自发、不抢即时通道，审计另记一条 ui_crash", () => {
    renderCrashed();
    expect(centerMocks.reportError).toHaveBeenCalledTimes(1);
    const input = centerMocks.reportError.mock.calls[0][0];
    expect(input.title).toBe(translate("crash.messageTitle"));
    expect(input.source).toBe("AppErrorBoundary");
    expect(input.origin).toBe("system");
    // 界面上已经当场说了一遍，再弹一条 toast 就是同一件事播报两次（feedback-channels §6）
    expect(input.toast).toBe(false);
    expect(input.detail).toBe(document.querySelector(".app-crash-detail")?.textContent ?? "");
    expect(auditMocks.appendAuditEvent).toHaveBeenCalledTimes(1);
    const event = auditMocks.appendAuditEvent.mock.calls[0][0];
    expect(event.kind).toBe("ui_crash");
    expect(event.result).toBe("failure");
    expect(event.error).toBe(input.detail);
  });

  it("登记通道自己抛错时，兜底界面不能跟着塌", () => {
    centerMocks.reportError.mockImplementation(() => {
      throw new Error("消息中心也挂了");
    });
    auditMocks.appendAuditEvent.mockImplementation(() => {
      throw new Error("审计也挂了");
    });
    triggerCrash();
    render(<Harness />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(document.querySelector(".app-crash-detail")?.textContent).toContain(BOOM_MESSAGE);
  });

  it("英文界面下诊断标签跟着语言走，不甩一串中文给用户", () => {
    localStorage.setItem("locale", "en-US");
    triggerCrash();
    render(<Harness />);
    const detail = document.querySelector(".app-crash-detail")?.textContent ?? "";
    expect(detail).toContain("React component stack");
    expect(detail).not.toContain("React 组件栈");
    expect(screen.getByRole("alert").textContent).toContain("This screen stopped rendering");
  });
});

describe("buildCrashDiagnostics", () => {
  it("拿不到组件栈时也要写清楚，不留一段空白", () => {
    const error = new Error("无栈可用");
    error.stack = undefined;
    const text = buildCrashDiagnostics(error, "", new Date("2026-10-27T00:00:00.000Z"));
    expect(text).toContain(`Error: 无栈可用`);
    expect(text).toContain(`${translate("crash.stackLabel")}: ${translate("crash.stackNone")}`);
    expect(text).toContain("2026-10-27T00:00:00.000Z");
  });
});

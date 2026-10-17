/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "../test/react";
import { translate } from "../locales";
import ExternalLink from "./ExternalLink";

/**
 * 波41（R66）：外链点击在桌面端必须落到系统浏览器，而不是「点了没反应」。
 * 这里跑真链路（组件 → lib/externalLink），只把剪贴板换掉，
 * 于是「接管导航 / 走运行时 / 退回 window.open / 都不行就复制」四条路都有断言。
 */

const clipboardMock = vi.hoisted(() => ({ copyText: vi.fn(async (_text: string) => true) }));

vi.mock("../lib/clipboard", () => ({ copyText: clipboardMock.copyText }));

const GH = "https://github.com/Adsryen/ConfScope";

function renderLink() {
  return render(
    <ExternalLink href={GH} className="btn btn-ghost btn-sm" title="GitHub">
      ⭐ GitHub
    </ExternalLink>
  );
}

function setRuntime(browserOpen: (url: string) => void) {
  Object.defineProperty(window, "runtime", { configurable: true, writable: true, value: { BrowserOpenURL: browserOpen } });
}

describe("ExternalLink 把外链交给系统浏览器", () => {
  let toastTexts: string[] = [];
  let unsubscribe: (() => void) | undefined;

  beforeEach(async () => {
    clipboardMock.copyText.mockReset();
    clipboardMock.copyText.mockImplementation(async () => true);
    const toastModule = await import("../lib/toast");
    toastModule.clearToasts();
    toastTexts = [];
    unsubscribe = toastModule.subscribe((items) => {
      toastTexts = items.map((item) => `${item.type}:${item.text}`);
    });
  });

  afterEach(() => {
    unsubscribe?.();
    delete (window as { runtime?: unknown }).runtime;
    vi.restoreAllMocks();
  });

  it("href/target/rel 都留在 DOM 上，右键复制链接这类原生习惯不受影响", () => {
    const { container } = renderLink();
    const link = container.querySelector("a") as HTMLAnchorElement;

    expect(link.getAttribute("href")).toBe(GH);
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    expect(link.textContent).toContain("GitHub");
  });

  it("左键点击被接管，不让文档自己去导航", () => {
    const { container } = renderLink();
    const link = container.querySelector("a") as HTMLAnchorElement;
    vi.spyOn(window, "open").mockReturnValue({} as Window);

    // fireEvent 返回 !defaultPrevented：false 说明我们确实 preventDefault 了
    expect(fireEvent.click(link)).toBe(false);
  });

  it("桌面端（有 Wails 运行时）走 BrowserOpenURL，不碰 window.open", async () => {
    const { container } = renderLink();
    const link = container.querySelector("a") as HTMLAnchorElement;
    const browserOpen = vi.fn();
    setRuntime(browserOpen);
    const openSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);

    fireEvent.click(link);
    await vi.waitFor(() => expect(browserOpen).toHaveBeenCalledWith(GH));
    expect(openSpy).not.toHaveBeenCalled();
    expect(clipboardMock.copyText).not.toHaveBeenCalled();
    expect(toastTexts).toEqual([]);
  });

  it("web / dev（无运行时）退回 window.open，参数与白名单口径一致", async () => {
    const { container } = renderLink();
    const link = container.querySelector("a") as HTMLAnchorElement;
    const openSpy = vi.spyOn(window, "open").mockReturnValue({} as Window);

    fireEvent.click(link);
    await vi.waitFor(() => expect(openSpy).toHaveBeenCalledWith(GH, "_blank", "noopener,noreferrer"));
  });

  it("弹窗被拦截时把链接复制进剪贴板并提示，而不是静默失败", async () => {
    const { container } = renderLink();
    const link = container.querySelector("a") as HTMLAnchorElement;
    vi.spyOn(window, "open").mockReturnValue(null);

    fireEvent.click(link);
    await vi.waitFor(() => expect(clipboardMock.copyText).toHaveBeenCalledWith(GH));
    expect(toastTexts.join("|")).toContain(`info:${translate("common.openLinkCopied")}`);
  });

  it("运行时抛异常也算失败，同样落到复制兜底", async () => {
    const { container } = renderLink();
    const link = container.querySelector("a") as HTMLAnchorElement;
    setRuntime(() => {
      throw new Error("WailsInvoke is not defined");
    });
    vi.spyOn(window, "open").mockReturnValue(null);

    fireEvent.click(link);
    await vi.waitFor(() => expect(clipboardMock.copyText).toHaveBeenCalledWith(GH));
  });
});

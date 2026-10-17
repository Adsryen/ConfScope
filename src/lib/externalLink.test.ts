// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "../locales";
import { EXTERNAL_URL_PROTOCOLS, normalizeExternalUrl, openExternalLink, openExternalUrl } from "./externalLink";

/**
 * R66：桌面 webview 里 window.open / target=_blank 没有落地窗口
 * （Wails v2.13 只认 runtime.BrowserOpenURL → WailsInvoke('BO:'+url)，
 * 整个包搜不到 NewWindowRequested，也不拦 window.open），
 * 所以「点了没反应」是真 bug 而不是体验瑕疵。这个文件钉住三条命脉：
 * 桌面走运行时、web 回退 window.open、两条路都不通时把 URL 交给剪贴板并说清楚。
 */

const clipboardMock = vi.hoisted(() => ({ copyText: vi.fn(async (_text: string) => true) }));

vi.mock("./clipboard", () => ({ copyText: clipboardMock.copyText }));

/** 只声明 helper 真正会碰的那几个成员，避免把 jsdom 的 Window 拖进断言。 */
interface FakeWindow {
  runtime?: { BrowserOpenURL?: (url: string) => void };
  open?: (url: string, target?: string, features?: string) => unknown;
}

function desktopWindow(browserOpen = vi.fn()): FakeWindow & { open: ReturnType<typeof vi.fn> } {
  return { runtime: { BrowserOpenURL: browserOpen }, open: vi.fn(() => ({}) as unknown) };
}

function webWindow(open = vi.fn(() => ({}) as unknown)): FakeWindow {
  return { open };
}

describe("外链打开的唯一出口（波41 R66）", () => {
  let toastItems: string[] = [];
  let unsubscribe: (() => void) | undefined;
  let toastModule: typeof import("./toast");

  beforeEach(async () => {
    clipboardMock.copyText.mockReset();
    clipboardMock.copyText.mockImplementation(async () => true);
    toastModule = await import("./toast");
    toastModule.clearToasts();
    toastItems = [];
    unsubscribe = toastModule.subscribe((items) => {
      toastItems = items.map((item) => `${item.type}:${item.text}`);
    });
  });

  afterEach(() => {
    unsubscribe?.();
    toastModule.clearToasts();
    vi.restoreAllMocks();
  });

  it("scheme 白名单只有 http/https/mailto，javascript/data/file 不在名单里", () => {
    expect([...EXTERNAL_URL_PROTOCOLS].sort()).toEqual(["http:", "https:", "mailto:"]);
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd"]) {
      expect(normalizeExternalUrl(bad)).toBeNull();
    }
  });

  it("归一化把 Go 侧会拒的空格与控制字符编码掉，其余保持原样", () => {
    // Wails 的 ValidateAndSanitizeURL 把空格也列进 shell 元字符黑名单，
    // 前端不预处理的话，桌面端会「静默什么都不发生」。
    expect(normalizeExternalUrl("https://github.com/a b/Release Note.md")).toBe("https://github.com/a%20b/Release%20Note.md");
    expect(normalizeExternalUrl("  https://github.com/Adsryen/ConfScope  ")).toBe("https://github.com/Adsryen/ConfScope");
    expect(normalizeExternalUrl("mailto:ryen@example.com")).toBe("mailto:ryen@example.com");
    expect(normalizeExternalUrl("github.com/Adsryen")).toBeNull(); // 没有 scheme，交系统浏览器没有意义
    expect(normalizeExternalUrl("")).toBeNull();
  });

  it("桌面端走 runtime.BrowserOpenURL，绝不碰 window.open", () => {
    const win = desktopWindow();
    const browserOpen = win.runtime?.BrowserOpenURL as ReturnType<typeof vi.fn>;

    expect(openExternalUrl("https://github.com/Adsryen/ConfScope", win)).toBe(true);
    expect(browserOpen).toHaveBeenCalledTimes(1);
    expect(browserOpen).toHaveBeenCalledWith("https://github.com/Adsryen/ConfScope");
    expect(win.open).not.toHaveBeenCalled();
  });

  it("没有运行时（web / dev）回退 window.open 并按返回值判成败", () => {
    const win = webWindow();
    expect(openExternalUrl("https://github.com/Adsryen", win)).toBe(true);
    expect(win.open).toHaveBeenCalledWith("https://github.com/Adsryen", "_blank", "noopener,noreferrer");

    const blocked = webWindow(vi.fn(() => null));
    expect(openExternalUrl("https://github.com/Adsryen", blocked)).toBe(false);
  });

  it("运行时抛异常（WailsInvoke 缺失等）算失败，不静默吞掉", () => {
    const win: FakeWindow = {
      runtime: {
        BrowserOpenURL: () => {
          throw new Error("WailsInvoke is not defined");
        },
      },
      open: vi.fn(() => null),
    };
    expect(openExternalUrl("https://github.com/Adsryen", win)).toBe(false);
  });

  it("javascript: 之类的链接谁也不给，也不复制到剪贴板", async () => {
    const win = desktopWindow();
    const browserOpen = win.runtime?.BrowserOpenURL as ReturnType<typeof vi.fn>;

    await expect(openExternalLink("javascript:alert(1)", win)).resolves.toBe(false);
    expect(browserOpen).not.toHaveBeenCalled();
    expect(win.open).not.toHaveBeenCalled();
    expect(clipboardMock.copyText).not.toHaveBeenCalled();
    expect(toastItems.join("|")).toContain(translate("common.linkUnsafe"));
  });

  it("打不开时把原链接复制进剪贴板并提示用户", async () => {
    const win = webWindow(vi.fn(() => null));
    await expect(openExternalLink("https://github.com/Adsryen/ConfScope/issues", win)).resolves.toBe(false);
    expect(clipboardMock.copyText).toHaveBeenCalledWith("https://github.com/Adsryen/ConfScope/issues");
    expect(toastItems.join("|")).toContain(`info:${translate("common.openLinkCopied")}`);
  });

  it("连复制也失败时换成手动选择的提示，不报成功", async () => {
    clipboardMock.copyText.mockImplementation(async () => false);
    const win = webWindow(vi.fn(() => null));

    await expect(openExternalLink("https://github.com/Adsryen", win)).resolves.toBe(false);
    expect(toastItems.join("|")).toContain(`error:${translate("common.copyFailed")}`);
    expect(toastItems.join("|")).not.toContain(translate("common.openLinkCopied"));
  });

  it("桌面端成功时不复制也不提示", async () => {
    const win = desktopWindow();
    await expect(openExternalLink("https://github.com/Adsryen/ConfScope", win)).resolves.toBe(true);
    expect(clipboardMock.copyText).not.toHaveBeenCalled();
    expect(toastItems).toEqual([]);
  });
});

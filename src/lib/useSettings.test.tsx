/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettings } from "./useSettings";
import { loadSettings, saveSettings, subscribeSettings, updateCompareSettings } from "../store/settings";
import type { AppSettings } from "../store/settings";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

function seedSettings(patch?: Partial<AppSettings>) {
  const base = loadSettings();
  localStorage.setItem("cs.settings", JSON.stringify({ ...base, ...patch }));
}

describe("useSettings", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("挂载读一次磁盘作为初值", () => {
    seedSettings({ compare: { sortNamespaces: false, sortConnections: true } });
    const { result } = renderHook(() => useSettings());
    expect(result.current.compare.sortNamespaces).toBe(false);
  });

  // 轮47 R47-04：读方拿新值靠「写完即通知」，不靠宿主恰好重渲染。
  it("写入方一落盘就读到最新值，中间没有任何重渲染", () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.compare.sortNamespaces).toBe(true);

    act(() => {
      updateCompareSettings({ sortNamespaces: false });
    });

    expect(result.current.compare.sortNamespaces).toBe(false);
  });

  it("代理 / 启动 / 更新这些写入方也走同一条通知（它们都汇聚到 saveSettings）", () => {
    const { result } = renderHook(() => useSettings());
    act(() => {
      saveSettings({ ...result.current, proxy: { httpProxy: "http://127.0.0.1:7890", httpsProxy: "", noProxy: "" } });
    });
    expect(result.current.proxy.httpProxy).toBe("http://127.0.0.1:7890");
  });

  it("卸载即注销：离开页面的读方不再被惊动", () => {
    const { result, unmount } = renderHook(() => useSettings());
    unmount();

    act(() => {
      updateCompareSettings({ sortNamespaces: false });
    });

    // 卸载后的 hook 保持离开那一刻的值（React 也不会再为它渲染），且不会因残留订阅报错
    expect(result.current.compare.sortNamespaces).toBe(true);
  });

  it("取消注册函数生效；绕过 saveSettings 的裸写盘不通知（水合处需显式补通知）", () => {
    const seen: number[] = [];
    const unsubscribe = subscribeSettings(() => seen.push(1));

    localStorage.setItem("cs.settings", JSON.stringify({ compare: { sortNamespaces: false, sortConnections: false } }));
    expect(seen).toHaveLength(0);

    updateCompareSettings({ sortNamespaces: false });
    expect(seen).toHaveLength(1);

    unsubscribe();
    updateCompareSettings({ sortNamespaces: true });
    expect(seen).toHaveLength(1);
  });
});

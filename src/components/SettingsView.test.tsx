/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import SettingsView from "./SettingsView";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function renderSettings() {
  vi.stubGlobal("localStorage", new MemoryStorage());
  localStorage.setItem("locale", "zh-CN");
  return render(
    <I18nProvider>
      <SettingsView />
    </I18nProvider>
  );
}

describe("SettingsView", () => {
  it("keeps language and app preferences on the settings page", () => {
    renderSettings();

    expect(screen.getByText("设置")).toBeInTheDocument();
    expect(screen.getByText("语言")).toBeInTheDocument();
    expect(screen.getByText("智能对比")).toBeInTheDocument();
    expect(screen.getByText("网络代理")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("连接下拉按名称排序"));
    fireEvent.change(screen.getByLabelText("HTTP 代理"), {
      target: { value: "http://127.0.0.1:7890" },
    });

    expect(JSON.parse(localStorage.getItem("cs.settings") || "{}")).toEqual(
      expect.objectContaining({
        compare: expect.objectContaining({ sortConnections: false }),
        proxy: expect.objectContaining({ httpProxy: "http://127.0.0.1:7890" }),
      })
    );
  });
});

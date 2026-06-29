/**
 * @vitest-environment jsdom
 */
import { render, screen } from "../test/react";
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

describe("SettingsView", () => {
  it("keeps language settings on the settings page", () => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    localStorage.setItem("locale", "zh-CN");

    render(
      <I18nProvider>
        <SettingsView />
      </I18nProvider>
    );

    expect(screen.getByText("设置")).toBeInTheDocument();
    expect(screen.getByText("语言")).toBeInTheDocument();
  });
});

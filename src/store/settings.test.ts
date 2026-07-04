import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSettings, saveSettings, updateCompareSettings, updateProxySettings, updateStartupSettings } from "./settings";

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

describe("settings store", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("returns defaults when storage is empty or malformed", () => {
    expect(loadSettings()).toEqual({
      proxy: { httpProxy: "", httpsProxy: "", noProxy: "" },
      update: { skipVersion: "", lastCheckAt: "", lastSeenVersion: "" },
      compare: { sortConnections: true, sortNamespaces: true },
      startup: { lastOpenedVersion: "", lastShownWelcomeVersion: "", lastShownChangelogVersion: "" },
    });

    localStorage.setItem("cs.settings", "{bad json");

    expect(loadSettings()).toEqual({
      proxy: { httpProxy: "", httpsProxy: "", noProxy: "" },
      update: { skipVersion: "", lastCheckAt: "", lastSeenVersion: "" },
      compare: { sortConnections: true, sortNamespaces: true },
      startup: { lastOpenedVersion: "", lastShownWelcomeVersion: "", lastShownChangelogVersion: "" },
    });
  });

  it("persists global proxy settings", () => {
    updateProxySettings({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      noProxy: "localhost,127.0.0.1",
    });

    expect(loadSettings().proxy).toEqual({
      httpProxy: "http://127.0.0.1:7890",
      httpsProxy: "http://127.0.0.1:7890",
      noProxy: "localhost,127.0.0.1",
    });
  });

  it("preserves unrelated settings when saving", () => {
    saveSettings({
      proxy: { httpProxy: "", httpsProxy: "", noProxy: "" },
      update: { skipVersion: "1.2.0", lastCheckAt: "2026-06-28T00:00:00Z", lastSeenVersion: "" },
      compare: { sortConnections: false, sortNamespaces: true },
      startup: { lastOpenedVersion: "1.2.0", lastShownWelcomeVersion: "", lastShownChangelogVersion: "1.2.0" },
    });

    updateProxySettings({ httpProxy: "http://proxy.local:8080" });

    expect(loadSettings()).toEqual({
      proxy: { httpProxy: "http://proxy.local:8080", httpsProxy: "", noProxy: "" },
      update: { skipVersion: "1.2.0", lastCheckAt: "2026-06-28T00:00:00Z", lastSeenVersion: "" },
      compare: { sortConnections: false, sortNamespaces: true },
      startup: { lastOpenedVersion: "1.2.0", lastShownWelcomeVersion: "", lastShownChangelogVersion: "1.2.0" },
    });
  });

  it("persists compare sorting preferences", () => {
    updateCompareSettings({ sortConnections: false, sortNamespaces: false });

    expect(loadSettings().compare).toEqual({
      sortConnections: false,
      sortNamespaces: false,
    });
  });

  it("persists startup dialog state", () => {
    updateStartupSettings({
      lastOpenedVersion: "1.3.0",
      lastShownWelcomeVersion: "1.3.0",
    });

    expect(loadSettings().startup).toEqual({
      lastOpenedVersion: "1.3.0",
      lastShownWelcomeVersion: "1.3.0",
      lastShownChangelogVersion: "",
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSettings,
  saveSettings,
  subscribeSettings,
  updateCompareSettings,
  updateDuplicateCheckSettings,
  updateProxySettings,
  updateStartupSettings,
} from "./settings";

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
      duplicateCheck: { keyDupEnabled: true, exactBodyEnabled: true, ignoredKeyPatterns: [] },
    });

    localStorage.setItem("cs.settings", "{bad json");

    expect(loadSettings()).toEqual({
      proxy: { httpProxy: "", httpsProxy: "", noProxy: "" },
      update: { skipVersion: "", lastCheckAt: "", lastSeenVersion: "" },
      compare: { sortConnections: true, sortNamespaces: true },
      startup: { lastOpenedVersion: "", lastShownWelcomeVersion: "", lastShownChangelogVersion: "" },
      duplicateCheck: { keyDupEnabled: true, exactBodyEnabled: true, ignoredKeyPatterns: [] },
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
      duplicateCheck: { keyDupEnabled: true, exactBodyEnabled: true, ignoredKeyPatterns: ["*.tmp"] },
    });

    updateProxySettings({ httpProxy: "http://proxy.local:8080" });

    expect(loadSettings()).toEqual({
      proxy: { httpProxy: "http://proxy.local:8080", httpsProxy: "", noProxy: "" },
      update: { skipVersion: "1.2.0", lastCheckAt: "2026-06-28T00:00:00Z", lastSeenVersion: "" },
      compare: { sortConnections: false, sortNamespaces: true },
      startup: { lastOpenedVersion: "1.2.0", lastShownWelcomeVersion: "", lastShownChangelogVersion: "1.2.0" },
      duplicateCheck: { keyDupEnabled: true, exactBodyEnabled: true, ignoredKeyPatterns: ["*.tmp"] },
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

describe("duplicateCheck settings (r110)", () => {
  it("falls back to defaults when an old document lacks the section", () => {
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({
        proxy: { httpProxy: "", httpsProxy: "", noProxy: "" },
        update: { skipVersion: "", lastCheckAt: "", lastSeenVersion: "" },
        compare: { sortConnections: true, sortNamespaces: true },
        startup: { lastOpenedVersion: "", lastShownWelcomeVersion: "", lastShownChangelogVersion: "" },
      })
    );

    expect(loadSettings().duplicateCheck).toEqual({
      keyDupEnabled: true,
      exactBodyEnabled: true,
      ignoredKeyPatterns: [],
    });
  });

  it("filters non-string patterns and keeps booleans from a malformed section", () => {
    localStorage.setItem(
      "cs.settings",
      JSON.stringify({
        duplicateCheck: {
          keyDupEnabled: false,
          ignoredKeyPatterns: ["db.*", 42, null, { pattern: "x" }],
        },
      })
    );

    expect(loadSettings().duplicateCheck).toEqual({
      keyDupEnabled: false,
      exactBodyEnabled: true,
      ignoredKeyPatterns: ["db.*"],
    });
  });

  it("persists a whole ignore-list patch and notifies subscribers once", () => {
    let notified = 0;
    const unsubscribe = subscribeSettings(() => {
      notified += 1;
    });

    updateDuplicateCheckSettings({ ignoredKeyPatterns: ["db.*", "redis.*"] });
    unsubscribe();

    expect(loadSettings().duplicateCheck.ignoredKeyPatterns).toEqual(["db.*", "redis.*"]);
    expect(notified).toBe(1);
  });

  it("keeps the other criteria when patching the ignore list", () => {
    updateDuplicateCheckSettings({ keyDupEnabled: false });
    updateDuplicateCheckSettings({ ignoredKeyPatterns: ["tmp.*"] });

    expect(loadSettings().duplicateCheck).toEqual({
      keyDupEnabled: false,
      exactBodyEnabled: true,
      ignoredKeyPatterns: ["tmp.*"],
    });
  });
});

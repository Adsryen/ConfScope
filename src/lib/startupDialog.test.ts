import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../store/settings";
import { hasExistingStartupData, startupDialogKind } from "./startupDialog";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  clear() {
    this.values.clear();
  }
}

function settings(startup: Partial<AppSettings["startup"]> = {}): AppSettings {
  return {
    proxy: { httpProxy: "", httpsProxy: "", noProxy: "" },
    update: { skipVersion: "", lastCheckAt: "", lastSeenVersion: "" },
    compare: { sortConnections: true, sortNamespaces: true },
    startup: {
      lastOpenedVersion: "",
      lastShownWelcomeVersion: "",
      lastShownChangelogVersion: "",
      ...startup,
    },
  };
}

describe("startupDialog", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("shows welcome for a fresh install that has not seen this version", () => {
    expect(startupDialogKind({ currentVersion: "1.3.0", settings: settings(), hasExistingAppData: false })).toBe("welcome");
  });

  it("shows update notes for an existing profile that has not seen this version", () => {
    expect(
      startupDialogKind({
        currentVersion: "1.3.0",
        settings: settings({ lastOpenedVersion: "1.2.0" }),
        hasExistingAppData: true,
      })
    ).toBe("updated");
  });

  it("does not show the same welcome or update dialog twice", () => {
    expect(
      startupDialogKind({
        currentVersion: "1.3.0",
        settings: settings({ lastShownWelcomeVersion: "1.3.0" }),
        hasExistingAppData: false,
      })
    ).toBeNull();
    expect(
      startupDialogKind({
        currentVersion: "1.3.0",
        settings: settings({ lastShownChangelogVersion: "1.3.0" }),
        hasExistingAppData: true,
      })
    ).toBeNull();
  });

  it("does not turn a dismissed fresh-install welcome into an update dialog on next launch", () => {
    expect(
      startupDialogKind({
        currentVersion: "1.3.0",
        settings: settings({ lastShownWelcomeVersion: "1.3.0" }),
        hasExistingAppData: true,
      })
    ).toBeNull();
  });

  it("detects existing app data from persisted app keys", () => {
    expect(hasExistingStartupData()).toBe(false);

    localStorage.setItem("cs.connections", "[]");

    expect(hasExistingStartupData()).toBe(true);
  });
});

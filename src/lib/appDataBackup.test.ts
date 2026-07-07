import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_DATA_BACKUP_SCHEMA_VERSION,
  collectAppDataBackupPayload,
  restoreAppDataBackupPayload,
  summarizeAppDataBackupPayload,
  validateAppDataBackupPayload,
} from "./appDataBackup";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  clear(): void {
    this.values.clear();
  }
}

function seedCurrentAppData(): void {
  localStorage.setItem(
    "cs.connections",
    JSON.stringify([
      {
        id: "conn-1",
        name: "Dev",
        baseUrl: "http://127.0.0.1:8848/nacos",
        username: "nacos",
        password: "nacos-secret",
        defaultNamespace: "",
        accessKeySecret: "ak-secret",
      },
    ])
  );
  localStorage.setItem(
    "cs.sshProfiles",
    JSON.stringify([
      {
        id: "ssh-1",
        name: "Jump",
        config: { host: "jump.local", port: 22, username: "ops", authType: "key", privateKey: "PRIVATE", passphrase: "KEY-PASS" },
        createdAt: "2026-07-07T00:00:00.000Z",
        updatedAt: "2026-07-07T00:00:00.000Z",
      },
    ])
  );
  localStorage.setItem("cs.settings", JSON.stringify({ proxy: { httpProxy: "http://proxy", httpsProxy: "", noProxy: "localhost" } }));
  localStorage.setItem("cs.operationHistory", JSON.stringify([]));
  localStorage.setItem("cs.applyPlans", JSON.stringify([]));
  localStorage.setItem("cs.applyVerifications", JSON.stringify([]));
  localStorage.setItem("cs.ui", JSON.stringify({ connId: "conn-1", mode: "browse", sidebarCollapsed: false }));
  localStorage.setItem("locale", "en-US");
  localStorage.setItem(
    "cs.appDataBackup",
    JSON.stringify({ webdav: { enabled: true, url: "https://dav.example.com", username: "ops", password: "dav-secret", rootPath: "/confscope" } })
  );
}

describe("appDataBackup lib", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("collects all app data sections including recoverable secrets", () => {
    seedCurrentAppData();

    const payload = collectAppDataBackupPayload({
      appVersion: "1.4.2",
      sourcePlatform: "windows",
      createdAt: "2026-07-07T08:00:00.000Z",
    });

    expect(payload.schemaVersion).toBe(APP_DATA_BACKUP_SCHEMA_VERSION);
    expect(payload.data.connections[0]).toEqual(expect.objectContaining({ password: "nacos-secret", accessKeySecret: "ak-secret" }));
    expect(payload.data.sshProfiles[0]).toEqual(
      expect.objectContaining({ config: expect.objectContaining({ privateKey: "PRIVATE", passphrase: "KEY-PASS" }) })
    );
    expect(payload.data.ui).toEqual({ connId: "conn-1", mode: "browse", sidebarCollapsed: false });
    expect(payload.data.locale).toBe("en-US");
    expect(payload.data.appDataBackup).toEqual(expect.objectContaining({ webdav: expect.objectContaining({ password: "dav-secret" }) }));
  });

  it("summarizes section counts for restore preview", () => {
    seedCurrentAppData();
    const payload = collectAppDataBackupPayload({
      appVersion: "1.4.2",
      sourcePlatform: "windows",
      createdAt: "2026-07-07T08:00:00.000Z",
    });

    expect(summarizeAppDataBackupPayload(payload)).toEqual({
      schemaVersion: 1,
      appVersion: "1.4.2",
      createdAt: "2026-07-07T08:00:00.000Z",
      sourcePlatform: "windows",
      sections: {
        connections: 1,
        sshProfiles: 1,
        operationHistory: 0,
        applyPlans: 0,
        applyVerifications: 0,
      },
      hasSettings: true,
      hasUi: true,
      locale: "en-US",
      includesSensitiveData: true,
    });
  });

  it("rejects invalid payloads before restore", () => {
    expect(() => validateAppDataBackupPayload({ schemaVersion: 99 })).toThrow("不支持的应用数据备份版本");
    expect(() =>
      validateAppDataBackupPayload({
        schemaVersion: 1,
        createdAt: "2026-07-07T08:00:00.000Z",
        appVersion: "1.4.2",
        sourcePlatform: "windows",
        data: { connections: "not-array" },
      })
    ).toThrow("应用数据备份缺少有效分区: connections");
  });

  it("restores by fully replacing known localStorage keys", () => {
    seedCurrentAppData();
    const payload = collectAppDataBackupPayload({
      appVersion: "1.4.2",
      sourcePlatform: "windows",
      createdAt: "2026-07-07T08:00:00.000Z",
    });
    localStorage.setItem("cs.connections", JSON.stringify([{ id: "old", name: "Old" }]));
    localStorage.setItem("cs.applyPlans", JSON.stringify([{ id: "stale" }]));
    localStorage.setItem("cs.unrelated", "keep");

    restoreAppDataBackupPayload(payload);

    expect(JSON.parse(localStorage.getItem("cs.connections") || "[]")[0]).toEqual(expect.objectContaining({ id: "conn-1" }));
    expect(localStorage.getItem("cs.applyPlans")).toBe("[]");
    expect(JSON.parse(localStorage.getItem("cs.ui") || "{}")).toEqual({ connId: "conn-1", mode: "browse", sidebarCollapsed: false });
    expect(localStorage.getItem("locale")).toBe("en-US");
    expect(localStorage.getItem("cs.unrelated")).toBe("keep");
  });
});

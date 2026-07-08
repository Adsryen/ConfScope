import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_DATA_BACKUP_SCHEMA_VERSION,
  collectAppDataBackupPayload,
  collectPortableAppDataBackupPayload,
  restoreAppDataBackupPayload,
  summarizeAppDataBackupPayload,
  validateAppDataBackupPayload,
} from "./appDataBackup";
import type { StoredSecretPointer } from "./credentialSecrets";

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
  localStorage.setItem(
    "cs.snapshotWebDAV",
    JSON.stringify({
      webdav: { enabled: true, url: "https://dav.example.com", username: "ops", password: "snapshot-dav-secret", rootPath: "/confscope/snapshots" },
      activities: [],
    })
  );
}

function pointer(ref: string, namespace: StoredSecretPointer["namespace"], ownerId: string, field: string): StoredSecretPointer {
  return {
    ref,
    namespace,
    ownerId,
    field,
    migratedAt: "2026-07-08T00:00:00.000Z",
    status: "stored",
  };
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
    expect(payload.data.snapshotWebDAV).toEqual(expect.objectContaining({ webdav: expect.objectContaining({ password: "snapshot-dav-secret" }) }));
  });

  it("collects a portable payload by resolving secretRefs back to plaintext and removing source-machine pointers", async () => {
    seedCurrentAppData();
    localStorage.setItem(
      "cs.connections",
      JSON.stringify([
        {
          id: "conn-1",
          name: "Dev",
          baseUrl: "http://127.0.0.1:8848/nacos",
          username: "nacos",
          password: "",
          apolloToken: "",
          defaultNamespace: "",
          secretRefs: {
            password: pointer("connection.conn-1.password", "connection", "conn-1", "password"),
            apolloToken: pointer("connection.conn-1.apolloToken", "connection", "conn-1", "apolloToken"),
          },
        },
      ])
    );
    localStorage.setItem(
      "cs.appDataBackup",
      JSON.stringify({
        webdav: {
          enabled: true,
          url: "https://dav.example.com",
          username: "ops",
          password: "",
          rootPath: "/confscope",
          passwordSecretRef: pointer("app-data-webdav.default.password", "app-data-webdav", "default", "password"),
        },
        activities: [],
      })
    );
    localStorage.setItem(
      "cs.snapshotWebDAV",
      JSON.stringify({
        webdav: {
          enabled: true,
          url: "https://dav.example.com",
          username: "ops",
          password: "",
          rootPath: "/confscope/snapshots",
          passwordSecretRef: pointer("snapshot-webdav.default.password", "snapshot-webdav", "default", "password"),
        },
        activities: [],
      })
    );

    const payload = await collectPortableAppDataBackupPayload(
      { appVersion: "1.4.2", sourcePlatform: "windows", createdAt: "2026-07-07T08:00:00.000Z" },
      { resolveSecret: async (secret) => `resolved:${secret.ref}` }
    );

    expect(payload.data.connections[0]).toEqual(
      expect.objectContaining({
        password: "resolved:connection.conn-1.password",
        apolloToken: "resolved:connection.conn-1.apolloToken",
      })
    );
    expect(JSON.stringify(payload.data.connections[0])).not.toContain("secretRefs");
    expect(payload.data.appDataBackup).toEqual(
      expect.objectContaining({
        webdav: expect.objectContaining({ password: "resolved:app-data-webdav.default.password" }),
      })
    );
    expect(JSON.stringify(payload.data.appDataBackup)).not.toContain("passwordSecretRef");
    expect(payload.data.snapshotWebDAV).toEqual(
      expect.objectContaining({
        webdav: expect.objectContaining({ password: "resolved:snapshot-webdav.default.password" }),
      })
    );
    expect(JSON.stringify(payload.data.snapshotWebDAV)).not.toContain("passwordSecretRef");
    expect(localStorage.getItem("cs.connections")).toContain("secretRefs");
  });

  it("keeps explicit plaintext secrets over stale secretRefs when collecting a portable payload", async () => {
    seedCurrentAppData();
    localStorage.setItem(
      "cs.connections",
      JSON.stringify([
        {
          id: "conn-1",
          name: "Dev",
          baseUrl: "http://127.0.0.1:8848/nacos",
          username: "nacos",
          password: "fresh-nacos-secret",
          apolloToken: "fresh-apollo-token",
          defaultNamespace: "",
          secretRefs: {
            password: pointer("connection.conn-1.password", "connection", "conn-1", "password"),
            apolloToken: pointer("connection.conn-1.apolloToken", "connection", "conn-1", "apolloToken"),
          },
        },
      ])
    );
    localStorage.setItem(
      "cs.appDataBackup",
      JSON.stringify({
        webdav: {
          enabled: true,
          url: "https://dav.example.com",
          username: "ops",
          password: "fresh-app-webdav-secret",
          rootPath: "/confscope",
          passwordSecretRef: pointer("app-data-webdav.default.password", "app-data-webdav", "default", "password"),
        },
        activities: [],
      })
    );
    localStorage.setItem(
      "cs.snapshotWebDAV",
      JSON.stringify({
        webdav: {
          enabled: true,
          url: "https://dav.example.com",
          username: "ops",
          password: "fresh-snapshot-webdav-secret",
          rootPath: "/confscope/snapshots",
          passwordSecretRef: pointer("snapshot-webdav.default.password", "snapshot-webdav", "default", "password"),
        },
        activities: [],
      })
    );
    const resolveSecret = vi.fn(async (secret: StoredSecretPointer) => `stale:${secret.ref}`);

    const payload = await collectPortableAppDataBackupPayload(
      { appVersion: "1.4.2", sourcePlatform: "windows", createdAt: "2026-07-07T08:00:00.000Z" },
      { resolveSecret }
    );

    expect(resolveSecret).not.toHaveBeenCalled();
    expect(payload.data.connections[0]).toEqual(
      expect.objectContaining({
        password: "fresh-nacos-secret",
        apolloToken: "fresh-apollo-token",
      })
    );
    expect(JSON.stringify(payload.data.connections[0])).not.toContain("secretRefs");
    expect(payload.data.appDataBackup).toEqual(
      expect.objectContaining({
        webdav: expect.objectContaining({ password: "fresh-app-webdav-secret" }),
      })
    );
    expect(JSON.stringify(payload.data.appDataBackup)).not.toContain("passwordSecretRef");
    expect(payload.data.snapshotWebDAV).toEqual(
      expect.objectContaining({
        webdav: expect.objectContaining({ password: "fresh-snapshot-webdav-secret" }),
      })
    );
    expect(JSON.stringify(payload.data.snapshotWebDAV)).not.toContain("passwordSecretRef");
  });

  it("blocks portable export when any migrated secret cannot be resolved", async () => {
    seedCurrentAppData();
    localStorage.setItem(
      "cs.connections",
      JSON.stringify([
        {
          id: "conn-1",
          name: "Dev",
          baseUrl: "http://127.0.0.1:8848/nacos",
          username: "nacos",
          password: "",
          defaultNamespace: "",
          secretRefs: {
            password: pointer("connection.conn-1.password", "connection", "conn-1", "password"),
          },
        },
      ])
    );

    await expect(
      collectPortableAppDataBackupPayload(
        { appVersion: "1.4.2", sourcePlatform: "windows", createdAt: "2026-07-07T08:00:00.000Z" },
        { resolveSecret: async () => Promise.reject(new Error("missing secret")) }
      )
    ).rejects.toThrow("导出应用数据备份前无法解析 connection.conn-1.password");
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
    expect(JSON.parse(localStorage.getItem("cs.snapshotWebDAV") || "{}")).toEqual(
      expect.objectContaining({ webdav: expect.objectContaining({ password: "snapshot-dav-secret" }) })
    );
    expect(localStorage.getItem("cs.unrelated")).toBe("keep");
  });
});

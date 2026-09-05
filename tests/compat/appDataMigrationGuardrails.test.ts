import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_DATA_LAST_WRITE_KEY,
  bootstrapAppDataDoc,
  collectAppDataDocument,
  consumeAppDataDocNotice,
  hydrateStorageFromDocument,
  installAppDataDocSync,
  rehydrateFromAppDataDoc,
  _resetAppDataDocStateForTests,
  type AppDataDocument,
} from "../../src/lib/appDataDoc";
import type { AppDataBackupPayload } from "../../src/lib/appDataBackup";
import { restoreAppDataBackupPayload, validateAppDataBackupPayload } from "../../src/lib/appDataBackup";
import { loadAppDataBackupState } from "../../src/store/appDataBackup";
import { loadApplyPlans } from "../../src/store/applyPlans";
import { loadApplyVerifications } from "../../src/store/applyVerifications";
import { loadConnections } from "../../src/store/connections";
import { loadOperationHistory } from "../../src/store/operationHistory";
import { loadSettings } from "../../src/store/settings";
import { loadSSHProfiles } from "../../src/store/sshProfiles";
import { legacyAppDataBackupPayload, legacyApplyPlan, legacyApplyVerification, legacyLocalStorageSnapshot, seedStorage } from "../fixtures/legacyAppData";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function expectLegacyDataReadable(): void {
  const connections = loadConnections();
  expect(connections).toHaveLength(4);
  expect(connections[0]).toMatchObject({
    id: "legacy-nacos",
    provider: "nacos",
    projectName: "默认项目",
    environmentName: "未分组",
    sourceType: "nacos",
    authType: "nacos-password",
    sourceName: "Legacy Nacos",
    sshProfileId: "ssh-legacy",
    sshConfig: expect.objectContaining({ host: "jump-inline.local", username: "ops", password: "ssh-secret" }),
  });
  expect(connections[1]).toMatchObject({ provider: "apollo", apolloToken: "apollo-token", apolloAppId: "order-service" });
  expect(connections[2]).toMatchObject({ provider: "consul", consulToken: "consul-token", consulKeyPrefix: "apps/order/" });
  expect(connections[3]).toMatchObject({ provider: "local", sourceType: "local-snapshot", readonly: true });

  expect(loadSettings()).toMatchObject({
    compare: { sortConnections: true, sortNamespaces: true },
    startup: { lastOpenedVersion: "", lastShownWelcomeVersion: "", lastShownChangelogVersion: "" },
  });

  const history = loadOperationHistory();
  expect(history.map((record) => record.id)).toEqual(["legacy-publish", "legacy-apply-history"]);
  expect(history[0]).toMatchObject({
    beforeContent: "server.port: 8080",
    afterContent: "server.port: 9090",
  });
  expect(history[1]).toMatchObject({
    type: "apply",
    planId: legacyApplyPlan.id,
    planSummary: expect.objectContaining({ total: 1, overwrite: 1 }),
    backupSnapshotId: "before-legacy-apply",
  });

  const profiles = loadSSHProfiles();
  expect(profiles).toHaveLength(1);
  expect(profiles[0]).toMatchObject({
    id: "ssh-legacy",
    config: { host: "jump.local", port: 22, username: "root", authType: "password" },
  });

  expect(loadApplyPlans()).toEqual([legacyApplyPlan]);
  expect(loadApplyVerifications()).toEqual([legacyApplyVerification]);

  const appDataBackup = loadAppDataBackupState();
  expect(appDataBackup.webdav).toMatchObject({ rootPath: "/confscope", password: "dav-secret" });
  expect(appDataBackup.activities).toHaveLength(1);
  expect(appDataBackup.activities[0]).toMatchObject({ id: "activity-1", type: "webdav_upload" });
}

describe("local data migration guardrails", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("loads legacy localStorage data through current store normalizers", () => {
    seedStorage(localStorage, legacyLocalStorageSnapshot);

    expectLegacyDataReadable();
  });

  it("restores a schema v1 app-data backup and remains readable through loaders", () => {
    restoreAppDataBackupPayload(legacyAppDataBackupPayload);

    expectLegacyDataReadable();
  });

  it("keeps schema v1 app-data backup validation strict for missing sections", () => {
    const { applyVerifications: _applyVerifications, ...dataWithoutSection } = legacyAppDataBackupPayload.data;

    expect(() =>
      validateAppDataBackupPayload({
        ...legacyAppDataBackupPayload,
        data: dataWithoutSection,
      })
    ).toThrow("应用数据备份缺少有效分区: applyVerifications");
  });
});

describe("main data document (app-data/confscope-data.json)", () => {
  function installFakeBindings(fake: { get: unknown; save?: (document: unknown) => unknown; saveError?: unknown; saveCalls?: unknown[] }): void {
    (globalThis as Record<string, unknown>).go = {
      app: {
        App: {
          GetAppDataDocument: () => Promise.resolve(fake.get),
          SaveAppDataDocument: (document: unknown) => {
            fake.saveCalls?.push(document);
            if (fake.saveError) return Promise.reject(fake.saveError);
            return Promise.resolve(
              fake.save?.(document) ?? {
                exists: true,
                valid: true,
                path: "/data/app-data/confscope-data.json",
                schemaVersion: 2,
                savedAt: "2026-07-09T00:00:00.000Z",
                appVersion: "1.9.0",
                sizeBytes: 1,
              }
            );
          },
        },
      },
    };
  }

  function validDocStatus(document: AppDataDocument): unknown {
    return {
      exists: true,
      valid: true,
      path: "/data/app-data/confscope-data.json",
      schemaVersion: 2,
      savedAt: document.savedAt,
      appVersion: document.appVersion,
      sizeBytes: 1,
      document,
    };
  }

  function docFromBackupPayload(payload: AppDataBackupPayload): AppDataDocument {
    return {
      schemaVersion: 2,
      savedAt: "2026-07-08T00:00:00.000Z",
      appVersion: payload.appVersion,
      data: {
        connections: payload.data.connections,
        sshProfiles: payload.data.sshProfiles,
        settings: payload.data.settings,
        operationHistory: payload.data.operationHistory,
        applyPlans: payload.data.applyPlans,
        applyVerifications: payload.data.applyVerifications,
        diffViewPreferences: {},
        ui: payload.data.ui,
        locale: payload.data.locale,
        appDataBackup: payload.data.appDataBackup,
        snapshotWebDAV: { webdav: {} },
      },
    };
  }

  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
    delete (globalThis as Record<string, unknown>).go;
    _resetAppDataDocStateForTests();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).go;
    _resetAppDataDocStateForTests();
    vi.useRealTimers();
  });

  it("hydrates localStorage from a valid v2 document so legacy loaders read the file data", () => {
    hydrateStorageFromDocument(docFromBackupPayload(legacyAppDataBackupPayload));

    expectLegacyDataReadable();
  });

  it("collects a v2 document from legacy localStorage that round-trips back through hydration", () => {
    seedStorage(localStorage, legacyLocalStorageSnapshot);

    const document = collectAppDataDocument();
    expect(document.schemaVersion).toBe(2);
    expect(document.data.connections).toHaveLength(4);
    expect(document.data.locale).toBe("en-US");

    vi.stubGlobal("localStorage", new MemoryStorage());
    hydrateStorageFromDocument(document);

    expectLegacyDataReadable();
  });

  it("keeps the localStorage cache readable in web mode without native bindings", async () => {
    seedStorage(localStorage, legacyLocalStorageSnapshot);

    const result = await bootstrapAppDataDoc();

    expect(result.mode).toBe("web");
    expect(result.status).toBeNull();
    expectLegacyDataReadable();
  });

  it("migrates legacy localStorage into the file once when the document is missing", async () => {
    seedStorage(localStorage, legacyLocalStorageSnapshot);
    const saveCalls: unknown[] = [];
    installFakeBindings({ get: { exists: false, valid: false, path: "/data/app-data/confscope-data.json" }, saveCalls });

    const result = await bootstrapAppDataDoc();

    expect(result.mode).toBe("native");
    expect(saveCalls).toHaveLength(1);
    const saved = saveCalls[0] as AppDataDocument;
    expect(saved.schemaVersion).toBe(2);
    expect(saved.data.connections).toHaveLength(4);
    expect(consumeAppDataDocNotice()).toMatchObject({ kind: "imported-from-storage", connections: 4 });
    expectLegacyDataReadable();
  });

  it("restores data into an empty cache from the file and reports restored-from-file", async () => {
    installFakeBindings({ get: validDocStatus(docFromBackupPayload(legacyAppDataBackupPayload)), saveCalls: [] });

    const result = await bootstrapAppDataDoc();

    expect(result.status?.valid).toBe(true);
    expect(consumeAppDataDocNotice()).toMatchObject({ kind: "restored-from-file", connections: 4 });
    expectLegacyDataReadable();
  });

  it("falls back to the localStorage cache and reports corrupt-fallback when the document is invalid or the schema rolls back", async () => {
    seedStorage(localStorage, legacyLocalStorageSnapshot);
    // Go 侧对损坏文件或 schemaVersion 回退（如旧版 schema v1 文档）都返回 valid=false + 隔离路径
    installFakeBindings({
      get: {
        exists: true,
        valid: false,
        path: "/data/app-data/confscope-data.json",
        corruptFile: "/data/app-data/confscope-data.json.corrupt-1788543588999746700",
        error: "unsupported app data document schema version: 1",
      },
      saveCalls: [],
    });

    const result = await bootstrapAppDataDoc();

    expect(result.status?.valid).toBe(false);
    expect(result.status?.corruptFile).toContain(".corrupt-");
    expect(consumeAppDataDocNotice()).toMatchObject({ kind: "corrupt-fallback", connections: 4 });
    expectLegacyDataReadable();
  });

  it("writes back to the file when the localStorage cache is newer than the file", async () => {
    seedStorage(localStorage, legacyLocalStorageSnapshot);
    localStorage.setItem(APP_DATA_LAST_WRITE_KEY, JSON.stringify({ "cs.connections": "2999-01-01T00:00:00.000Z" }));
    const saveCalls: unknown[] = [];
    installFakeBindings({ get: validDocStatus(docFromBackupPayload(legacyAppDataBackupPayload)), saveCalls });

    await bootstrapAppDataDoc();

    expect(saveCalls).toHaveLength(1);
    const saved = saveCalls[0] as AppDataDocument;
    expect(saved.data.connections).toHaveLength(4);
    expect(consumeAppDataDocNotice()).toBeNull();
  });

  it("pushes a debounced document after data-key writes and retries save failures", async () => {
    vi.useFakeTimers();
    seedStorage(localStorage, legacyLocalStorageSnapshot);
    const saveCalls: unknown[] = [];
    installFakeBindings({ get: { exists: false, valid: false, path: "/data/app-data/confscope-data.json" }, saveError: new Error("disk full"), saveCalls });

    installAppDataDocSync();
    localStorage.setItem("cs.connections", JSON.stringify([]));

    // debounce 2s + 三次重试 2s/5s/10s
    await vi.advanceTimersByTimeAsync(2000 + 2000 + 5000 + 10000);

    expect(saveCalls).toHaveLength(4);
  });

  it("keeps >500KB apply plan payloads intact through the document round-trip", () => {
    const hugeContent = "x".repeat(600 * 1024);
    const plans = [
      {
        ...legacyApplyPlan,
        items: [
          {
            ...legacyApplyPlan.items[0],
            afterValue: { ...legacyApplyPlan.items[0].afterValue, value: hugeContent },
          },
        ],
      },
    ];
    seedStorage(localStorage, { "cs.applyPlans": JSON.stringify(plans) });

    const document = collectAppDataDocument();
    expect(JSON.stringify(document).length).toBeGreaterThan(500 * 1024);

    vi.stubGlobal("localStorage", new MemoryStorage());
    hydrateStorageFromDocument(document);

    const reloaded = JSON.parse(localStorage.getItem("cs.applyPlans") as string);
    expect(reloaded[0].items[0].afterValue.value).toBe(hugeContent);
  });

  it("rehydrates the cache from the file after a cache clear", async () => {
    seedStorage(localStorage, legacyLocalStorageSnapshot);
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key && key.startsWith("cs.")) localStorage.removeItem(key);
    }
    expect(localStorage.getItem("cs.connections")).toBeNull();

    installFakeBindings({ get: validDocStatus(docFromBackupPayload(legacyAppDataBackupPayload)), saveCalls: [] });

    const rehydrated = await rehydrateFromAppDataDoc();

    expect(rehydrated).toBe(true);
    expectLegacyDataReadable();
  });
});

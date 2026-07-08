import { beforeEach, describe, expect, it, vi } from "vitest";
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

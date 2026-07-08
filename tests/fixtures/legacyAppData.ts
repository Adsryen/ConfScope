import type { AppDataBackupPayload } from "../../src/lib/appDataBackup";
import type { ApplyPlan } from "../../src/lib/applyPlan";
import type { ApplyVerification } from "../../src/store/applyVerifications";

export const legacyApplyPlan: ApplyPlan = {
  schemaVersion: 1,
  id: "legacy-plan-1",
  createdAt: "2026-07-01T03:00:00.000Z",
  scope: "key",
  source: {
    envId: "legacy-nacos:",
    label: "Legacy Nacos / public",
    provider: "nacos",
    connectionId: "legacy-nacos",
    connectionName: "Legacy Nacos",
    namespace: "",
  },
  target: {
    envId: "prod-nacos:",
    label: "Prod Nacos / public",
    provider: "nacos",
    connectionId: "prod-nacos",
    connectionName: "Prod Nacos",
    namespace: "",
  },
  inputSummary: {
    sourceType: "diff",
    scope: "key",
    sourceLabel: "Legacy Nacos / public",
    targetLabel: "Prod Nacos / public",
    selectedCount: 1,
  },
  items: [
    {
      id: "nacos|prod-nacos||DEFAULT_GROUP|app.yaml|server.port",
      ref: {
        provider: "nacos",
        connectionId: "prod-nacos",
        namespace: "",
        group: "DEFAULT_GROUP",
        dataId: "app.yaml",
        key: "server.port",
      },
      sourceValue: {
        exists: true,
        value: "8080",
        valueType: "string",
        format: "YAML",
        parseStatus: "ok",
        fingerprint: "legacy-source-fingerprint",
      },
      targetValue: {
        exists: true,
        value: "9090",
        valueType: "string",
        format: "YAML",
        parseStatus: "ok",
        fingerprint: "legacy-target-fingerprint",
      },
      afterValue: {
        exists: true,
        value: "8080",
        valueType: "string",
        format: "YAML",
        parseStatus: "ok",
        fingerprint: "legacy-source-fingerprint",
      },
      action: "overwrite",
      blocked: false,
      sourceFingerprint: "legacy-source-fingerprint",
      targetFingerprint: "legacy-target-fingerprint",
    },
  ],
  summary: {
    total: 1,
    create: 0,
    overwrite: 1,
    delete: 0,
    skip: 0,
    parse_error: 0,
    blocked: 0,
  },
};

export const legacyApplyVerification: ApplyVerification = {
  id: "verify-legacy-1",
  planId: legacyApplyPlan.id,
  applyHistoryId: "legacy-apply-history",
  sandboxConnectionId: "legacy-nacos",
  sandboxConnectionName: "Legacy Nacos",
  sandboxNamespace: "",
  verifiedAt: "2026-07-01T04:00:00.000Z",
  verifiedTargetFingerprints: [
    {
      itemId: legacyApplyPlan.items[0].id,
      fingerprint: "sandbox-target-fingerprint",
    },
  ],
};

export const legacyLocalStorageSnapshot: Record<string, string> = {
  locale: "en-US",
  "cs.ui": JSON.stringify({ connId: "legacy-nacos", mode: "browse" }),
  "cs.settings": JSON.stringify({
    proxy: { httpProxy: "http://proxy.local:8080", httpsProxy: "", noProxy: "localhost,127.0.0.1" },
    update: { skipVersion: "", lastCheckAt: "2026-07-01T00:00:00.000Z", lastSeenVersion: "" },
  }),
  "cs.connections": JSON.stringify([
    {
      id: "legacy-nacos",
      name: "Legacy Nacos",
      baseUrl: "http://127.0.0.1:8848/nacos",
      username: "nacos",
      password: "nacos-secret",
      defaultNamespace: "",
      sshProfileId: "ssh-legacy",
      sshConfig: {
        host: "jump-inline.local",
        port: 22,
        username: "ops",
        authType: "password",
        password: "ssh-secret",
      },
      previousUnsupportedField: "ignored",
    },
    {
      id: "apollo-dev",
      name: "Apollo Dev",
      provider: "apollo",
      baseUrl: "http://127.0.0.1:8070",
      username: "",
      password: "",
      defaultNamespace: "order-service",
      apolloEnv: "DEV",
      apolloAppId: "order-service",
      apolloCluster: "default",
      apolloNamespaceName: "application",
      apolloToken: "apollo-token",
    },
    {
      id: "consul-dev",
      name: "Consul Dev",
      provider: "consul",
      baseUrl: "http://127.0.0.1:8500",
      username: "",
      password: "",
      defaultNamespace: "dc1",
      consulToken: "consul-token",
      consulDatacenter: "dc1",
      consulKeyPrefix: "apps/order/",
    },
    {
      id: "local-snapshot",
      name: "Local Snapshot",
      provider: "local",
      sourceType: "local-snapshot",
      baseUrl: "C:\\confscope\\snapshots\\legacy",
      localPath: "C:\\confscope\\snapshots\\legacy",
      username: "",
      password: "",
      defaultNamespace: "",
      readonly: true,
      localValidation: {
        valid: true,
        code: "legacy_valid",
        message: "Directory uses a legacy snapshot layout.",
        configCount: 1,
        legacy: true,
        checkedAt: "2026-07-01T00:00:00.000Z",
      },
    },
  ]),
  "cs.sshProfiles": JSON.stringify([
    {
      id: "ssh-legacy",
      name: "Legacy Jump",
      config: { host: "jump.local" },
      createdAt: "2026-07-01T00:00:00.000Z",
    },
    "bad-ssh-profile",
  ]),
  "cs.operationHistory": JSON.stringify([
    {
      id: "legacy-publish",
      type: "publish",
      result: "success",
      timestamp: "2026-07-01T01:00:00.000Z",
      connectionId: "legacy-nacos",
      connectionName: "Legacy Nacos",
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      previousContent: "server.port: 8080",
      content: "server.port: 9090",
    },
    {
      id: "legacy-apply-history",
      type: "apply",
      result: "success",
      timestamp: "2026-07-01T02:00:00.000Z",
      connectionId: "prod-nacos",
      connectionName: "Prod Nacos",
      namespace: "",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
      planId: legacyApplyPlan.id,
      planSummary: {
        scope: "key",
        total: 1,
        create: 0,
        overwrite: 1,
        delete: 0,
        skip: 0,
        parseError: 0,
        blocked: 0,
        sourceLabel: "Legacy Nacos / public",
        targetLabel: "Prod Nacos / public",
      },
      backupSnapshotId: "before-legacy-apply",
      backupSnapshotName: "before legacy apply",
    },
    { id: "bad-history", type: "unknown", result: "success", timestamp: "2026-07-01T00:00:00.000Z" },
  ]),
  "cs.applyPlans": JSON.stringify([{ id: "invalid-plan" }, legacyApplyPlan]),
  "cs.applyVerifications": JSON.stringify([
    legacyApplyVerification,
    {
      id: "bad-verification",
      planId: legacyApplyPlan.id,
      applyHistoryId: "bad-history",
      sandboxConnectionId: "legacy-nacos",
      sandboxConnectionName: "Legacy Nacos",
      sandboxNamespace: "",
      verifiedAt: "2026-07-01T04:30:00.000Z",
      verifiedTargetFingerprints: [{ itemId: "missing-fingerprint" }],
    },
  ]),
  "cs.appDataBackup": JSON.stringify({
    webdav: { enabled: true, url: "https://dav.example.com", username: "ops", password: "dav-secret", rootPath: "confscope" },
    activities: [
      { id: "activity-1", type: "webdav_upload", status: "success", target: "remote", message: "ok", createdAt: "2026-07-01T00:00:00.000Z" },
      { id: "bad-activity", type: "unknown", status: "success", target: "remote", message: "bad", createdAt: "2026-07-01T00:00:00.000Z" },
    ],
  }),
};

function parsedArray(key: keyof typeof legacyLocalStorageSnapshot): unknown[] {
  const value = JSON.parse(legacyLocalStorageSnapshot[key]);
  if (!Array.isArray(value)) throw new Error(`Legacy fixture section is not an array: ${key}`);
  return value;
}

function parsedObject(key: keyof typeof legacyLocalStorageSnapshot): Record<string, unknown> {
  const value = JSON.parse(legacyLocalStorageSnapshot[key]);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Legacy fixture section is not an object: ${key}`);
  return value;
}

export const legacyAppDataBackupPayload: AppDataBackupPayload = {
  schemaVersion: 1,
  appVersion: "1.6.1",
  sourcePlatform: "windows",
  createdAt: "2026-07-08T00:00:00.000Z",
  data: {
    connections: parsedArray("cs.connections"),
    sshProfiles: parsedArray("cs.sshProfiles"),
    settings: parsedObject("cs.settings"),
    operationHistory: parsedArray("cs.operationHistory"),
    applyPlans: parsedArray("cs.applyPlans"),
    applyVerifications: parsedArray("cs.applyVerifications"),
    ui: parsedObject("cs.ui"),
    locale: "en-US",
    appDataBackup: parsedObject("cs.appDataBackup"),
  },
};

export function seedStorage(storage: Storage, snapshot: Record<string, string> = legacyLocalStorageSnapshot): void {
  storage.clear();
  for (const [key, value] of Object.entries(snapshot)) {
    storage.setItem(key, value);
  }
}

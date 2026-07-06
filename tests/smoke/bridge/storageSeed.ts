import type { SmokeState } from "../env/workspace";

export interface BrowserStorageSeed {
  key: string;
  value: string;
}

export function createStorageSeed(state: SmokeState): BrowserStorageSeed[] {
  return [
    { key: "locale", value: "en-US" },
    {
      key: "cs.settings",
      value: JSON.stringify({
        proxy: { httpProxy: "", httpsProxy: "", noProxy: "127.0.0.1,localhost" },
        update: { skipVersion: "", lastCheckAt: "2026-07-07T00:00:00.000Z", lastSeenVersion: "" },
        compare: { sortConnections: true, sortNamespaces: true },
        startup: {
          lastOpenedVersion: "1.4.1-smoke",
          lastShownWelcomeVersion: "1.4.1-smoke",
          lastShownChangelogVersion: "1.4.1-smoke",
        },
      }),
    },
    {
      key: "cs.ui",
      value: JSON.stringify({ connId: "smoke-dev", mode: "browse", sidebarCollapsed: false }),
    },
    { key: "cs.connections", value: JSON.stringify(createConnections(state)) },
    { key: "cs.sshProfiles", value: JSON.stringify([]) },
    { key: "cs.operationHistory", value: JSON.stringify([]) },
    { key: "cs.applyPlans", value: JSON.stringify([]) },
    { key: "cs.applyVerifications", value: JSON.stringify([]) },
  ];
}

function createConnections(state: SmokeState): unknown[] {
  return [
    nacosConnection("smoke-dev", "Dev Nacos", "Development", state.nacos.dev.baseUrl),
    nacosConnection("smoke-sandbox", "Sandbox Nacos", "Test", state.nacos.sandbox.baseUrl),
    { ...nacosConnection("smoke-prod", "Prod Nacos", "Production", state.nacos.prod.baseUrl), safetyLevel: "protected" },
    localConnection("smoke-local-strict", "Strict Snapshot", state.fixtures.strictPublic, false),
    localConnection("smoke-local-legacy", "Legacy Snapshot", state.fixtures.legacyPublic, true),
  ];
}

function nacosConnection(id: string, name: string, environmentName: string, baseUrl: string): unknown {
  return {
    id,
    name,
    projectName: "Smoke Project",
    environmentName,
    sourceName: name,
    sourceType: "nacos",
    provider: "nacos",
    distribution: "opensource",
    authType: "none",
    baseUrl,
    username: "",
    password: "",
    defaultNamespace: "",
    useProxy: false,
  };
}

function localConnection(id: string, name: string, localPath: string, legacy: boolean): unknown {
  return {
    id,
    name,
    projectName: "Smoke Project",
    environmentName: "Local",
    sourceName: name,
    sourceType: "local-snapshot",
    provider: "local",
    distribution: "opensource",
    authType: "none",
    baseUrl: localPath,
    localPath,
    username: "",
    password: "",
    defaultNamespace: "",
    readonly: true,
    forceLocalSnapshot: false,
    localValidation: {
      valid: true,
      code: legacy ? "legacy_valid" : "valid",
      message: legacy ? "Directory uses a legacy snapshot layout." : "Directory is valid.",
      configCount: legacy ? 1 : 2,
      schemaVersion: legacy ? undefined : 1,
      layout: legacy ? undefined : "confscope-v1",
      legacy,
      checkedAt: "2026-07-07T00:00:00.000Z",
    },
  };
}

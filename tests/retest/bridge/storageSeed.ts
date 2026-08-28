import type { RetestState } from "../state";

export interface BrowserStorageSeed {
  key: string;
  value: string;
}

function nacosConnection(state: RetestState, id: string, name: string, env: "a" | "b"): unknown {
  const ep = state.nacos[env];
  return {
    id,
    name,
    projectName: "Retest Project",
    environmentName: "Development",
    sourceName: env === "a" ? "Retest Nacos A" : "Retest Nacos B",
    sourceType: "nacos",
    provider: "nacos",
    distribution: "opensource",
    authType: "none",
    baseUrl: ep.baseUrl,
    username: "",
    password: "",
    defaultNamespace: ep.namespace,
    useProxy: false,
  };
}

export function createRetestStorageSeed(state: RetestState): BrowserStorageSeed[] {
  return [
    { key: "locale", value: "zh-CN" },
    {
      key: "cs.settings",
      value: JSON.stringify({
        proxy: { httpProxy: "", httpsProxy: "", noProxy: "127.0.0.1,localhost" },
        update: { skipVersion: "", lastCheckAt: "2026-08-28T00:00:00.000Z", lastSeenVersion: "1.8.0" },
        compare: { sortConnections: true, sortNamespaces: true },
        startup: {
          lastOpenedVersion: "1.8.0",
          lastShownWelcomeVersion: "1.8.0",
          lastShownChangelogVersion: "1.8.0",
        },
      }),
    },
    {
      key: "cs.ui",
      value: JSON.stringify({ connId: "retest-a", mode: "browse", sidebarCollapsed: false }),
    },
    {
      key: "cs.connections",
      value: JSON.stringify([
        nacosConnection(state, "retest-a", "Retest Nacos A", "a"),
        nacosConnection(state, "retest-b", "Retest Nacos B", "b"),
      ]),
    },
    { key: "cs.sshProfiles", value: JSON.stringify([]) },
    { key: "cs.operationHistory", value: JSON.stringify([]) },
    { key: "cs.applyPlans", value: JSON.stringify([]) },
    { key: "cs.applyVerifications", value: JSON.stringify([]) },
  ];
}

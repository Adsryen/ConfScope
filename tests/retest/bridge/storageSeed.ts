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
    defaultGroup: "RETEST-PROD",
    useProxy: false,
  };
}

export function createRetestStorageSeed(state: RetestState): BrowserStorageSeed[] {
  // 防御：历史 run 的播种可能写入不含 defaultGroup 的 cs.connections，
  // 这里始终用本模块重新生成，保证复测数据自带默认 group。
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
      value: JSON.stringify({
        connId: "retest-a",
        mode: "diff",
        sidebarCollapsed: false,
        diffLeftConnId: "retest-a",
        diffRightConnId: "retest-b",
        // 两侧 namespace 不同（dev/qa），必须分开记录，DiffView 恢复时才不会跨连接错配
        diffLeft: { tenant: state.nacos.a.namespace, dataId: "svc-gateway.yaml", group: "RETEST-PROD" },
        diffRight: { tenant: state.nacos.b.namespace, dataId: "svc-gateway.yaml", group: "RETEST-PROD" },
        diffAutoCompare: true,
      }),
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

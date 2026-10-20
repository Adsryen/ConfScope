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
    // retest-b 标记为沙箱：ConfigBrowser「应用到目标环境」的 targetConnections
    // 需要沙箱/受管目标候选；真实产品里 QA/沙箱环境正是变更首跳目标。
    environmentName: env === "a" ? "Development" : "Sandbox",
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
        update: { skipVersion: "", lastCheckAt: "2026-08-28T00:00:00.000Z", lastSeenVersion: "1.9.2" },
        compare: { sortConnections: true, sortNamespaces: true },
        startup: {
          lastOpenedVersion: "1.9.2",
          lastShownWelcomeVersion: "1.9.2",
          lastShownChangelogVersion: "1.9.2",
        },
      }),
    },
    {
      key: "cs.ui",
      value: JSON.stringify({
        connId: "retest-a",
        mode: "diff",
        sidebarCollapsed: false,
        // 轮46 R01：这里不再写 diffLeft* / diffRight*。上一轮比的是哪一对只有一个主人
        // （下面的 cs.diffViewPreferences），种子造第二份就等于在测一个产品里不存在的状态。
        // 轮45 R02 的口径继续成立：「这一次要比」是一次性意图，谁都不许把它写进存储。
      }),
    },
    {
      // 对比页两侧来源（含各自的 namespace/group/dataId）：DiffView 挂载时自己恢复这一份，
      // 并在「上一轮退出时停在对比页 + 这一对齐全」时直接把上一对比出来（见 src/App.tsx 的
      // autoCompareOnRestore 与 src/components/DiffView.tsx 的恢复 effect）。
      // 两侧 namespace 不同（dev/sandbox），必须分开记录，恢复时才不会跨连接错配；
      // usesDefaultNamespace:true 让 tenant 跟随连接当前默认值，种子改命名空间时不用同步两处。
      key: "cs.diffViewPreferences",
      value: JSON.stringify({
        selectedProject: "Retest Project",
        left: {
          connId: "retest-a",
          tenant: state.nacos.a.namespace,
          dataId: "svc-gateway.yaml",
          group: "RETEST-PROD",
          usesDefaultNamespace: true,
        },
        right: {
          connId: "retest-b",
          tenant: state.nacos.b.namespace,
          dataId: "svc-gateway.yaml",
          group: "RETEST-PROD",
          usesDefaultNamespace: true,
        },
        mode: "text",
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

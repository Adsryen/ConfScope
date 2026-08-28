// 复测（retest）持久化 Nacos 环境状态。
// 与 tests/smoke 不同：容器长期保留（docker compose，卷持久化），数据自造，供真人模拟 UI 测试复用。
export interface RetestNacosEndpoint {
  baseUrl: string;
  clientPort: string;
  namespace: string;
  environment: string;
}

export interface RetestState {
  nacos: {
    a: RetestNacosEndpoint;
    b: RetestNacosEndpoint;
  };
  webServerUrl: string;
}

const DEFAULT_STATE: RetestState = {
  nacos: {
    a: { baseUrl: "http://127.0.0.1:19848/nacos", clientPort: "19880", namespace: "retest-dev", environment: "Development" },
    b: { baseUrl: "http://127.0.0.1:19849/nacos", clientPort: "19881", namespace: "retest-qa", environment: "QA" },
  },
  webServerUrl: "http://127.0.0.1:1420",
};

export function loadRetestState(): RetestState {
  return DEFAULT_STATE;
}

// 复测（retest）持久化 Nacos 环境状态。
// 与 tests/smoke 不同：容器长期保留（docker compose，卷持久化），数据自造，供真人模拟 UI 测试复用。
export interface RetestNacosEndpoint {
  baseUrl: string;
  clientPort: string;
  namespace: string;
  environment: string;
}

export interface RetestSshEndpoint {
  host: string;
  port: number;
  username: string;
  password: string;
  /** 密钥认证（J1 真实握手用）；密码字段供 UI 表单填写，retest 桥走 mock 成功路径 */
  privateKeyPath?: string;
}

export interface RetestState {
  nacos: {
    a: RetestNacosEndpoint;
    b: RetestNacosEndpoint;
  };
  ssh?: RetestSshEndpoint;
  webServerUrl: string;
}

const DEFAULT_STATE: RetestState = {
  nacos: {
    a: { baseUrl: "http://127.0.0.1:19848/nacos", clientPort: "19880", namespace: "retest-dev", environment: "Development" },
    b: { baseUrl: "http://127.0.0.1:19849/nacos", clientPort: "19881", namespace: "retest-qa", environment: "QA" },
  },
  // J1 用：真实 sshd 容器（confscope-retest-sshd2，端口 2223，密钥认证）。
  // S5 UI 测试走 mock 成功路径（retest 桥 TestSSHConnection：host 命中即返回 latencyMs）。
  // 真机握手由 tests/retest/j1-ssh-probe.test.ts 用 ssh2 + privateKey 验证。
  ssh: {
    host: "127.0.0.1",
    port: 2223,
    username: "retuser",
    password: "ret-test",
    privateKeyPath: "ssh-keys/id_ed25519",
  },
  webServerUrl: "http://127.0.0.1:1420",
};

export function loadRetestState(): RetestState {
  return DEFAULT_STATE;
}

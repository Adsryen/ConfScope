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
  // 默认打本机 dev server；worktree 里验证发版提交时另起一台（1430 等），
  // 用 CONFSCOPE_RETEST_BASE_URL 指过去，避免两套真机批共用 1420 抢同一份数据目录。
  webServerUrl: process.env.CONFSCOPE_RETEST_BASE_URL ?? "http://127.0.0.1:1420",
};

export function loadRetestState(): RetestState {
  return DEFAULT_STATE;
}

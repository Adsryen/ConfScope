// 环境名 → 色调档（唯一事实源，轮6 R44）。
//
// 以前这份规则在 ConnectionManager / DiffView / AuditView 各写了一份，
// AuditView 那份还少认 canary、local 两档：同一个「灰度」环境在侧栏和对比页是彩色徽章，
// 切到审计矩阵就退化成灰色，用户会以为是数据没读到。故收敛成一处，改档只改这里。

export type EnvironmentTone = "dev" | "test" | "staging" | "prod" | "canary" | "local" | "other";

/** 由环境名推断色调档；空名与无法识别的名字一律 other。 */
export function environmentTone(name: string): EnvironmentTone {
  const value = name.trim().toLowerCase();
  if (!value) return "other";
  if (value.includes("生产") || value.includes("prod")) return "prod";
  if (value.includes("预发") || value.includes("staging") || value.includes("stage") || value.includes("uat")) return "staging";
  if (value.includes("灰度") || value.includes("canary")) return "canary";
  if (value.includes("测试") || value.includes("test") || value.includes("qa")) return "test";
  if (value.includes("本地") || value.includes("local")) return "local";
  if (value.includes("开发") || value.includes("dev")) return "dev";
  return "other";
}

const SORT_WEIGHTS: Record<EnvironmentTone, number> = {
  dev: 10,
  test: 20,
  staging: 30,
  canary: 40,
  prod: 50,
  local: 60,
  other: 90,
};

/** 环境排序权重：dev → test → staging → canary → prod → local → other。 */
export function environmentSortWeight(name: string): number {
  return SORT_WEIGHTS[environmentTone(name)];
}

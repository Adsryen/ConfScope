/**
 * 环境色调规则只许有一份（轮6 R44）。
 *
 * 真 bug：这份「环境名 → 色调档」的判断在 ConnectionManager / DiffView / AuditView 各抄了一遍，
 * AuditView 那份还少认 canary、local 两档——同一个「灰度」环境在侧栏和对比页是彩色徽章，
 * 切到审计矩阵就退化成灰色，用户以为数据没读到。抄三份迟早漂移，所以钉死成单一事实源：
 * src/lib/envTone.ts，其余地方只许 import。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource, sourceFiles } from "./scanUtils";

const SINGLE_SOURCE = "src/lib/envTone.ts";
/** 以前那些副本里的特征写法：出现即说明又手搓了一份规则。 */
const DRIFT_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: 'includes("灰度")', pattern: /includes\(\s*["']灰度["']\s*\)/ },
  { label: 'includes("canary")', pattern: /includes\(\s*["']canary["']\s*\)/i },
  { label: 'includes("预发")', pattern: /includes\(\s*["']预发["']\s*\)/ },
  { label: 'includes("本地")', pattern: /includes\(\s*["']本地["']\s*\)/ },
  { label: "function environmentTone", pattern: /function\s+environmentTone\b/ },
  { label: "function environmentSortWeight", pattern: /function\s+environmentSortWeight\b/ },
  // 只算「本地又声明了一遍类型」，import 里的 `type EnvironmentTone` 是正当用法
  { label: "type EnvironmentTone = …", pattern: /^(?:export\s+)?type\s+EnvironmentTone\s*=/m },
];
/** 三个用色调的页面都必须从唯一事实源引入。 */
const CONSUMERS = ["src/components/ConnectionManager.tsx", "src/components/DiffView.tsx", "src/components/AuditView.tsx"];

describe("环境色调只有一个事实源", () => {
  it("唯一事实源里认全七档，且能识别灰度与本地", () => {
    const source = readScannedSource(SINGLE_SOURCE);
    ["prod", "staging", "canary", "test", "local", "dev", "other"].forEach((tone) => {
      expect(source, `envTone.ts 缺 ${tone} 档`).toContain(`"${tone}"`);
    });
    // 排序权重必须覆盖全部档位，否则 environmentSortWeight 会返回 undefined
    expect(source).toMatch(/SORT_WEIGHTS:\s*Record<EnvironmentTone,\s*number>/);
    ["dev", "test", "staging", "canary", "prod", "local", "other"].forEach((tone) => {
      expect(source, `SORT_WEIGHTS 缺 ${tone}`).toMatch(new RegExp(`\\n\\s*${tone}:\\s*\\d+,`));
    });
  });

  it("除唯一事实源外，src 里不得再出现第二份色调判断", () => {
    const files = sourceFiles().filter((file) => file !== SINGLE_SOURCE);
    const drift = files.flatMap((file) =>
      DRIFT_PATTERNS.filter(({ pattern }) => pattern.test(readScannedSource(file))).map(({ label }) => `${file} → ${label}`)
    );
    expect(drift).toEqual([]);
  });

  it("三个用色调的页面都 import 了唯一事实源", () => {
    CONSUMERS.forEach((file) => {
      const source = readScannedSource(file);
      expect(source, `${file} 不再从 lib/envTone 取色调`).toMatch(/from\s+"\.\.\/lib\/envTone"/);
      expect(source, `${file} 该用到 environmentTone`).toContain("environmentTone(");
    });
  });

  it("审计矩阵的环境徽章也走 environmentTone（R44 的退化就发生在这里）", () => {
    const audit = readFileSync(join(PROJECT_ROOT, "src/components/AuditView.tsx"), "utf8");
    expect(audit).toContain("env-badge env-${environmentTone(");
    expect(audit, "旧的那份少认 canary/local 的副本必须删干净").not.toContain("environmentToneShort");
  });
});

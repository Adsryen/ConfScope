/**
 * 守卫：遮码框只许有一份实现，且每个调用点都得把语义参数写全（轮67 R67-WP6）。
 *
 * 修前的真实形状（普查实测 18 处，不是 PRD 早先记的 10/12 处）：
 * - 12 处字面 `type="password"`：AppDataBackupPanel 8 处 + BackupView 2 处 + SSHManagerView 2 处，
 *   全部没有 name / autocomplete、没有回显开关（敲错了自己看不见），也没有显式 aria-labelledby；
 * - 6 处三元 `type={x ? "text" : "password"}`：全在 ConnectionManager，开关确实有，
 *   但其中一颗 `showPwd` 同时管着 Apollo Token / Consul Token / Nacos 密码 / AK Secret 四个框——
 *   点一下四个一起显出来，不是用户要的形状。
 *
 * 口径：
 * 1. `src/components/PasswordField.tsx` 之外，生产代码里不许再出现 password 类型的 `<input>`
 *    （字面与三元都算，只按 `type=` 属性判，避免把 `as "password" | "key"` 这类类型断言算进来）；
 * 2. 每个 `<PasswordField>` 调用点必须写全 label / name / autoComplete / value / onChange，
 *    autoComplete 只能取 WHATWG 的三个档位（写成变量等于让编译器闭嘴、浏览器自己猜）；
 * 3. 全站 `name` 字面量两两不重复——同屏重名会让自动填充填错框；
 * 4. 组件本体必须留着那几处兜底：`aria-labelledby={captionId}`（名字纯净的唯一解）、
 *    `spellCheck={false}`、静态 `aria-label` + `aria-pressed`、`onMouseDown` 阻止默认（焦点不抢）；
 * 5. 防永真：先拿修前的原样喂给探测器（必须全被抓），再拿修后的写法喂（一条都不许抓），
 *    并把调用点数量下限钉在 18——扫描口径漂了先在数量上红，而不是让规则空转把违规吞掉。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

const COMPONENT = "src/components/PasswordField.tsx";
const AUTOCOMPLETE_ARMS = ["new-password", "current-password", "off"];
/** 字面 password。 */
const LITERAL_PASSWORD_TYPE = /\btype\s*=\s*["']password["']/;
/** 三元/表达式里含 password 分支（`type={showPwd ? "text" : "password"}`）。 */
const DYNAMIC_PASSWORD_TYPE = /\btype\s*=\s*\{[^{}]*["']password["'][^{}]*\}/;
/** 修前的两段真实原样，用来证明探测器不是空转。 */
const PRE_FIX_SAMPLES = [
  '<input className="search-input" type="password" value={restorePassword} onChange={(e) => setRestorePassword(e.target.value)} />',
  '<input className="search-input wide mono" type={showPwd ? "text" : "password"} value={draft.password} />',
  '<input\n  className="search-input wide mono"\n  type={showSSHPassphrase ? "text" : "password"}\n  value={draft.sshConfig?.passphrase || ""}\n/>',
];
/** 修后的合规写法，一条都不许被抓。 */
const POST_FIX_SAMPLES = [
  '<PasswordField label={t("appDataBackup.restorePassword")} value={restorePassword} name="app-data-restore-password" autoComplete="off" onChange={setRestorePassword} />',
  '<input type={config.mode} value={v} />',
  'const next = { authType: value as "password" | "key" };',
];

/** 取 `<PasswordField` 开标签的属性区：花括号/引号里的 `>` 不算结束。 */
function openTagAttrs(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (ch === ">" && depth === 0) return source.slice(start, i);
  }
  return source.slice(start);
}

interface CallSite {
  file: string;
  line: number;
  attrs: string;
}

function callSites(): CallSite[] {
  const found: CallSite[] = [];
  for (const rel of sourceFiles()) {
    const source = readScannedSource(rel);
    for (const m of source.matchAll(/<PasswordField\b/g)) {
      const at = m.index ?? 0;
      found.push({ file: rel, line: source.slice(0, at).split("\n").length, attrs: openTagAttrs(source, at + m[0].length) });
    }
  }
  return found;
}

function literalAttr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[1] ?? m[2]) : undefined;
}

describe("遮码框必须共用 PasswordField（R67-WP6 守卫）", () => {
  const sites = callSites();

  it("探测器有效：修前的原样全被抓，修后的写法一个都不抓", () => {
    for (const sample of PRE_FIX_SAMPLES) {
      expect(LITERAL_PASSWORD_TYPE.test(sample) || DYNAMIC_PASSWORD_TYPE.test(sample), `${sample} 是修前的违规原样，探测器抓不到就说明口径漂了`).toBe(true);
    }
    for (const sample of POST_FIX_SAMPLES) {
      expect(LITERAL_PASSWORD_TYPE.test(sample)).toBe(false);
      expect(DYNAMIC_PASSWORD_TYPE.test(sample)).toBe(false);
    }
  });

  it("组件之外不许再有 password 类型的 <input>", () => {
    const violations: string[] = [];
    for (const rel of sourceFiles()) {
      if (rel === COMPONENT) continue;
      const source = readScannedSource(rel);
      for (const m of source.matchAll(/<input\b[^>]*?(?=>)/gs)) {
        const tag = m[0];
        if (LITERAL_PASSWORD_TYPE.test(tag) || DYNAMIC_PASSWORD_TYPE.test(tag)) {
          violations.push(`${rel}:${source.slice(0, m.index ?? 0).split("\n").length}`);
        }
      }
    }
    expect(violations.join("\n")).toBe("");
  });

  it("调用点数量下限 18（少了就是有人把口令框写回裸 <input>）", () => {
    expect(sites.length).toBeGreaterThanOrEqual(18);
  });

  it("每个调用点都写全 label / name / autoComplete / value / onChange", () => {
    const missing: string[] = [];
    for (const site of sites) {
      for (const prop of ["label", "name", "autoComplete", "value", "onChange"]) {
        if (!new RegExp(`(?:^|\\s)${prop}\\s*=`).test(site.attrs)) {
          missing.push(`${site.file}:${site.line} 缺 ${prop}`);
        }
      }
      const auto = literalAttr(site.attrs, "autoComplete");
      if (auto !== undefined && !AUTOCOMPLETE_ARMS.includes(auto)) {
        missing.push(`${site.file}:${site.line} autoComplete="${auto}" 不是合法档位（也不许写成变量让浏览器自己猜）`);
      }
    }
    expect(missing.join("\n")).toBe("");
  });

  it("全站 name 字面量两两不重复，且都是小写连字符", () => {
    const seen = new Map<string, string>();
    const bad: string[] = [];
    for (const site of sites) {
      const name = literalAttr(site.attrs, "name");
      if (name === undefined) continue;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) bad.push(`${site.file}:${site.line} name="${name}" 不是小写连字符`);
      const prev = seen.get(name);
      if (prev) bad.push(`${site.file}:${site.line} name="${name}" 与 ${prev} 重名，自动填充会填错框`);
      else seen.set(name, `${site.file}:${site.line}`);
    }
    expect(bad.join("\n")).toBe("");
    expect(seen.size).toBeGreaterThanOrEqual(18);
  });

  it("组件本体留着名字与红线的兜底写法", () => {
    const source = readScannedSource(COMPONENT);
    for (const snippet of [
      "aria-labelledby={captionId}",
      "spellCheck={false}",
      'autoCapitalize="off"',
      'autoCorrect="off"',
      'aria-label={t("common.revealPassword")}',
      "aria-pressed={shown}",
      "onMouseDown={(e) => e.preventDefault()}",
      "<span id={captionId}>{label}</span>",
    ]) {
      expect(source, `PasswordField 丢了 ${snippet}`).toContain(snippet);
    }
  });
});

/**
 * 与通用行骨架 `data-list-item` 同处一个行的族类，不许被「不带骨架」的页面复用（R77 / 波47）。
 *
 * 为什么要守这一条：数据管理页的行有两种写法——
 *   `<button class="data-list-item backup-item">`（带骨架，display:block + 透明底 + 仅底边线）
 *   `<div class="history-item">`（HistoryView 自己那套：display:flex + 一圈边框）
 * 2026-07-04 两笔提交各写一套样式并共用 `.history-item` / `.history-list`，同特异度下靠后的静默覆盖靠前的，
 * 结果两个页面同时坏而无人报错：版本历史相邻行之间 2px 双线；操作历史的左列表被 `width:320px` 钉死，
 * 网格里留下 285px 死白区（Playwright 实测见 09-18 轮任务 research/before-computed.json）。
 * `duplicateSelectors.test.ts` 只比「同选择器 + 同属性」，结构上检不到这种**跨选择器**的串味，所以单独守。
 *
 * 口径：只看 className 里的字符串/模板字面量，按 token 精确匹配（`task-item-name` 不算 `task-item`，
 * 叶子类允许跨页共用）。跨行书写的 className 只取首行——真实的两处都在同一行内，够用。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const COMPONENT_DIR = join(PROJECT_ROOT, "src/components");
const SKELETON = "data-list-item";

/** className 里的一段字面量：所在文件、行号、类 token、该行是否同时带骨架类。 */
interface ClassLiteral {
  file: string;
  line: number;
  tokens: string[];
  withSkeleton: boolean;
}

interface Violation {
  file: string;
  line: number;
  token: string;
}

const LITERAL_RE = /"([^"\\\n]*)"|`([^`\\\n]*)`/g;

/** 去掉 `${…}` 插值（含嵌套），只留静态类名。 */
function stripInterpolation(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("${", i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") depth -= 1;
        i += 1;
      }
      out += " ";
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

function classTokens(text: string): string[] {
  return stripInterpolation(text)
    .split(/[^A-Za-z0-9_-]+/)
    .filter((token) => /^[a-z][a-z0-9-]*$/i.test(token));
}

/** 逐行取 className 字面量。只看 className= 之后的部分，避免把 title/aria-label 里的空格串当类名。 */
export function collectClassLiterals(source: string, file: string): ClassLiteral[] {
  const found: ClassLiteral[] = [];
  source.split("\n").forEach((rawLine, index) => {
    const at = rawLine.indexOf("className=");
    if (at === -1) return;
    const line = rawLine.slice(at);
    LITERAL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LITERAL_RE.exec(line)) !== null) {
      const tokens = classTokens(match[1] ?? match[2]);
      if (tokens.length === 0) continue;
      found.push({ file, line: index + 1, tokens, withSkeleton: tokens.includes(SKELETON) });
    }
  });
  return found;
}

/** 族类 = 与骨架同处一行的其他类；违规 = 这些类又出现在不带骨架的行上。 */
export function analyzeRowNamespaces(literals: ClassLiteral[]): { family: Set<string>; violations: Violation[] } {
  const family = new Set<string>();
  for (const item of literals) {
    if (!item.withSkeleton) continue;
    for (const token of item.tokens) if (token !== SKELETON) family.add(token);
  }
  const violations: Violation[] = [];
  for (const item of literals) {
    if (item.withSkeleton) continue;
    for (const token of item.tokens) if (family.has(token)) violations.push({ file: item.file, line: item.line, token });
  }
  return { family, violations };
}

function scanRepo(): { literals: ClassLiteral[]; family: Set<string>; violations: Violation[] } {
  const files = readdirSync(COMPONENT_DIR).filter((name) => name.endsWith(".tsx") && !name.includes(".test."));
  const literals = files.flatMap((name) => collectClassLiterals(readFileSync(join(COMPONENT_DIR, name), "utf8"), name));
  const { family, violations } = analyzeRowNamespaces(literals);
  return { literals, family, violations };
}

describe("行骨架族类不与非骨架行复用（R77）", () => {
  const { family, violations } = scanRepo();

  it("确实扫到了带骨架的行族类，否则这条守卫是空的", () => {
    expect([...family].sort()).toEqual(["backup-item", "op-history-item", "task-item"]);
  });

  it("族类不得出现在不带 data-list-item 的行元素上", () => {
    expect(
      violations.map((item) => `${item.file}:${item.line} ${item.token}`).sort(),
      "有族类被不带骨架的页面复用了：两套行样式会同特异度互相覆盖，见文件头注释"
    ).toEqual([]);
  });

  it("操作历史不再占用 history-item / history-list 两个类名", () => {
    const source = readFileSync(join(COMPONENT_DIR, "OperationHistoryView.tsx"), "utf8");
    const bare = collectClassLiterals(source, "OperationHistoryView.tsx").filter((item) =>
      item.tokens.some((token) => token === "history-item" || token === "history-list")
    );
    expect(bare.map((item) => item.line)).toEqual([]);
  });
});

describe("守卫自身的负控", () => {
  it("抓到 bug 原形：族类同时出现在带骨架与不带骨架的行上", () => {
    const literals = [
      ...collectClassLiterals('<button className={`data-list-item history-item ${ok ? "active" : ""}`}">', "OHV.tsx"),
      ...collectClassLiterals('<div className={`history-item${viewing ? " active" : ""}`}">', "HV.tsx"),
    ];
    const { family, violations } = analyzeRowNamespaces(literals);
    expect(family.has("history-item")).toBe(true);
    expect(violations).toEqual([{ file: "HV.tsx", line: 1, token: "history-item" }]);
  });

  it("叶子类跨页共用不算违规（token 精确匹配）", () => {
    const literals = [
      ...collectClassLiterals(
        '<button className="data-list-item task-item"><span className="task-item-name">a</span></button>',
        "TaskCenter.tsx"
      ),
      ...collectClassLiterals('<div className="history-item"><span className="task-item-name">b</span></div>', "HistoryView.tsx"),
    ];
    expect(analyzeRowNamespaces(literals).violations).toEqual([]);
  });

  it("只写骨架类、不写族类的行不贡献族类", () => {
    const literals = collectClassLiterals('<div className={`data-list-item${active ? " active" : ""}`}">', "LogViewer.tsx");
    expect(literals.map((item) => item.tokens)).toEqual([["data-list-item"]]);
    expect(analyzeRowNamespaces(literals).family.size).toBe(0);
  });

  it("插值里的标识符不会被当成类名", () => {
    const literals = collectClassLiterals('<button className={`data-list-item ${stateClass} ${x ? "danger" : ""} `}>', "A.tsx");
    expect(literals[0].tokens).toEqual(["data-list-item"]);
  });
});

/**
 * 静态守卫共用的源码扫描工具（轮6 起收在一处）。
 *
 * 为什么要有这个文件：tests/ux 下每条守卫都要「读源码 + 剥注释 + 摊平 locales」，
 * 各自手写正则时会漏掉字符串里的 `//`（URL）或把注释里的示例当成真代码。
 * 口径统一在这里，守卫只描述约束本身。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * 剥掉行注释（双斜杠起）与块注释（斜杠星起、星斜杠收），用等长空白替换。
 *
 * 保留行数与列位置，命中时 report 的行号才和真实文件对得上；
 * 字符串字面量里的 `//`（例如 https 链接）不能被当注释，所以要带引号状态机。
 */
export function stripComments(text: string): string {
  const out: string[] = [];
  let quote: string | null = null;
  let line = false;
  let block = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (line) {
      if (ch === "\n") {
        line = false;
        out.push(ch);
      } else {
        out.push(" ");
      }
      continue;
    }
    if (block) {
      if (ch === "*" && next === "/") {
        block = false;
        out.push("  ");
        i += 1;
      } else {
        out.push(ch === "\n" ? "\n" : " ");
      }
      continue;
    }
    if (quote) {
      out.push(ch);
      if (ch === "\\") {
        out.push(next ?? "");
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out.push(ch);
      continue;
    }
    if (ch === "/" && next === "/") {
      line = true;
      out.push("  ");
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      block = true;
      out.push("  ");
      i += 1;
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}

/**
 * 单个文件要不要进静态扫描（`sourceFiles()` 的判据，摊出来才能被用例直接验）。
 *
 * `locales` 那条例外是路径级的，交给调用方按 rel 过滤；其余只看文件名。
 */
export function isScannedSourceName(name: string): boolean {
  if (!/\.(ts|tsx)$/.test(name)) return false;
  if (/\.(test|spec)\.(ts|tsx)$/.test(name)) return false;
  // Syncthing 的冲突副本（<name>.sync-conflict-<日期>-<设备>）。
  // 它的后缀仍是 .tsx，但不是 `.test.tsx` 收尾，上面那条排除判据抓不到它，
  // 于是整份旧代码会被当成源码扫进守卫里，报出一堆「源码里有旧句式」的假红
  // （轮66 实测：另一台设备把旧仓库同步过来时一次性塞进 59 份，tsc 也被判红）。
  if (name.includes(".sync-conflict-")) return false;
  return true;
}

/** src 下参与扫描的源码文件（相对 PROJECT_ROOT 的路径），排除测试与 locales。 */
export function sourceFiles(): string[] {
  const walk = (dir: string, acc: string[]): string[] => {
    for (const entry of readdirSync(join(PROJECT_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(rel, acc);
        continue;
      }
      if (!isScannedSourceName(entry.name)) continue;
      if (rel.startsWith("src/locales/")) continue;
      acc.push(rel);
    }
    return acc;
  };
  return walk("src", []).sort();
}

/** 读源码并剥注释；keepRaw 为 true 时返回原文（写报错信息时用来取行号上下文）。 */
export function readScannedSource(relPath: string): string {
  return stripComments(readFileSync(join(PROJECT_ROOT, relPath), "utf8"));
}

/** 相对路径在原文里的行号（1 起）。 */
export function lineAt(relPath: string, index: number): number {
  const raw = readFileSync(join(PROJECT_ROOT, relPath), "utf8");
  return raw.slice(0, index).split("\n").length;
}

export type LocaleTree = Record<string, unknown>;

/** 把嵌套的 locale JSON 摊平成 `a.b.c` → 文本。 */
export function flattenLocale(tree: LocaleTree, prefix = ""): Record<string, string> {
  const acc: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object") {
      Object.assign(acc, flattenLocale(value as LocaleTree, full));
    } else {
      acc[full] = String(value);
    }
  }
  return acc;
}

export function loadLocale(file: string): Record<string, string> {
  const tree = JSON.parse(readFileSync(join(PROJECT_ROOT, "src/locales", file), "utf8")) as LocaleTree;
  return flattenLocale(tree);
}

/** 取 `key` 在树里的字面量集合：`export type X = "a" | "b"` 这类闭包枚举靠正则拿到全部档位。 */
export function unionMembers(relPath: string, declaration: RegExp): string[] {
  const source = readScannedSource(relPath);
  const found = declaration.exec(source);
  if (!found) return [];
  return Array.from(found[1].matchAll(/"([^"]+)"/g), (m) => m[1]);
}

/** 首字母大写，与组件里 `x.charAt(0).toUpperCase() + x.slice(1)` 的拼法一致。 */
export function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

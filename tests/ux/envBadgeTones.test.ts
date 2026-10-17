/**
 * 环境徽章的色调类必须有对应的样式（R34）。
 *
 * 扫出来的真 bug：DiffView 里快照来源写的是 `className="env-badge local"`，样式里只有 `.env-local`，
 * `local` 这个类谁都认不得——那两枚徽章于是只有边框、没有底色和文字色，和其他徽章明显不是一套。
 * 这类错不报错、不飘红，只会「看起来怪」，所以把 写死的类名 → 色调函数的返回值 → 样式 三头串起来守一次。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CSS = join(PROJECT_ROOT, "src/styles.css");
/** 文件名 → 该文件里给徽章挑色调的函数名。 */
const TONE_FN_BY_FILE: Record<string, string> = {
  "DiffView.tsx": "environmentTone",
  "ConnectionManager.tsx": "environmentTone",
  "AuditView.tsx": "environmentToneShort",
};
/** 徽章一共该有哪几种色调。 */
const EXPECTED_TONES = ["prod", "staging", "canary", "test", "local", "dev", "other"];

/** 注释里也写着 `.env-*` 的说明文字，扫之前一律剥掉，免得正则误命中。 */
function cssBody(): string {
  return readFileSync(CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

function componentSource(file: string): string {
  return readFileSync(join(PROJECT_ROOT, "src/components", file), "utf8");
}

/** styles.css 里真正定义过的色调类，例如 `.env-prod {` → "prod"。 */
function definedTones(): string[] {
  return Array.from(cssBody().matchAll(/(^|[},\s])\.env-([a-z]+)\s*\{/gm), (match) => match[2]);
}

/** 色调函数体里 `return "xxx"` 的全部可能值。 */
function returnedTones(file: string): string[] {
  const source = componentSource(file);
  const fnName = TONE_FN_BY_FILE[file];
  const start = source.indexOf(`function ${fnName}`);
  expect(start, `${file} 里找不到 ${fnName}，改写法要一起改这条守卫`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end, `${fnName} 的函数体收尾找不到`).toBeGreaterThan(start);
  return Array.from(source.slice(start, end).matchAll(/return "([a-z]+)"/g), (match) => match[1]);
}

describe("环境徽章的色调类与样式对得上", () => {
  const tones = definedTones();

  it(`样式里 ${EXPECTED_TONES.length} 种色调齐全，缺一种就会有徽章不着色`, () => {
    EXPECTED_TONES.forEach((tone) => {
      expect(tones, `styles.css 里没有 .env-${tone}`).toContain(tone);
    });
  });

  it("色调函数每个返回值都有对应样式", () => {
    Object.keys(TONE_FN_BY_FILE).forEach((file) => {
      const produced = returnedTones(file);
      expect(produced.length, `${file} 的色调函数一个 return 都没抓到`).toBeGreaterThan(0);
      produced.forEach((tone) => {
        expect(tones, `${file} 会返回 "${tone}"，但样式里没有 .env-${tone}`).toContain(tone);
      });
    });
  });

  it("写死的 className 必须带一个真实存在的 env- 色调类", () => {
    const literals = Object.keys(TONE_FN_BY_FILE).flatMap((file) =>
      Array.from(componentSource(file).matchAll(/className="env-badge([^"]*)"/g), (match) => ({ file, extra: match[1].trim() }))
    );
    expect(literals.length, "找不到写死的 env-badge 用法，改写法要一起改这条守卫").toBeGreaterThan(0);
    literals.forEach(({ file, extra }) => {
      expect(extra, `${file} 这枚写死的徽章没带 env- 色调类，会不着色`).toMatch(/^env-[a-z]+$/);
    });
  });
});

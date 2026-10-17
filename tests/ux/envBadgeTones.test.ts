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
/** 色调函数的唯一事实源（轮6 R44 前各页一份，现在收敛到 lib/envTone.ts）。 */
const TONE_SOURCE_FILE = "src/lib/envTone.ts";
/** 徽章一共该有哪几种色调。 */
const EXPECTED_TONES = ["prod", "staging", "canary", "test", "local", "dev", "other"];

/** 注释里也写着 `.env-*` 的说明文字，扫之前一律剥掉，免得正则误命中。 */
function cssBody(): string {
  return readFileSync(CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

function toneSource(): string {
  return readFileSync(join(PROJECT_ROOT, TONE_SOURCE_FILE), "utf8");
}

/**
 * styles.css 里真正定义过的色调类，例如 `.env-prod {` → "prod"。
 * R83 起这些色调写成复合形式 `.env-badge.env-prod {`（裸类名和 `.env-badge` 的 border 简写同特异度，
 * 谁生效只靠文档顺序决胜）：旧正则要求 `.env-` 前面是行首/逗号/空白，撞上复合选择器就整族看不见，
 * 当场误报「7 种色调全缺」。两种写法都收，将来谁退回裸类名这条守卫照样认。
 */
function definedTones(): string[] {
  const body = cssBody();
  const compound = Array.from(body.matchAll(/\.env-badge\.env-([a-z]+)\s*\{/g), (match) => match[1]);
  const bare = Array.from(body.matchAll(/(^|[},\s])\.env-([a-z]+)\s*\{/gm), (match) => match[2]);
  return Array.from(new Set([...compound, ...bare]));
}

/** 色调函数体里 `return "xxx"` 的全部可能值。 */
function returnedTones(): string[] {
  const source = toneSource();
  const start = source.indexOf("export function environmentTone");
  expect(start, `${TONE_SOURCE_FILE} 里找不到 environmentTone，改写法要一起改这条守卫`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end, "environmentTone 的函数体收尾找不到").toBeGreaterThan(start);
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
    const produced = returnedTones();
    expect(produced.length, "色调函数一个 return 都没抓到").toBeGreaterThan(0);
    produced.forEach((tone) => {
      expect(tones, `envTone.ts 会返回 "${tone}"，但样式里没有 .env-${tone}`).toContain(tone);
    });
    // 七档都要真被函数返回过，少一档就等于「某个环境永远灰」（other 有两条 return：空名与认不出）
    expect(Array.from(new Set(produced)).sort()).toEqual([...EXPECTED_TONES].sort());
  });

  it("写死的 className 必须带一个真实存在的 env- 色调类", () => {
    const literals = ["DiffView.tsx", "ConnectionManager.tsx", "AuditView.tsx"].flatMap((file) =>
      Array.from(readFileSync(join(PROJECT_ROOT, "src/components", file), "utf8").matchAll(/className="env-badge([^"]*)"/g), (match) => ({
        file,
        extra: match[1].trim(),
      }))
    );
    expect(literals.length, "找不到写死的 env-badge 用法，改写法要一起改这条守卫").toBeGreaterThan(0);
    literals.forEach(({ file, extra }) => {
      expect(extra, `${file} 这枚写死的徽章没带 env- 色调类，会不着色`).toMatch(/^env-[a-z]+$/);
    });
  });
});

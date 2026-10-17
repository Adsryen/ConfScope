/**
 * 内联错误块只认一个出口（轮13 波28 / R48）。
 *
 * 缺陷长什么样：`.inline-error` 那套 head + title + actions + `<pre>` 在 6 个文件里被手抄了
 * 13 份（7 份写在各 View 里、2 份是 ConfigBrowser/AppDataBackupPanel 的私有组件）。
 * `role="alert"`、详情区的 `tabIndex={0} + role="region" + aria-label` 全靠「抄的人记得抄全」，
 * 手抄漏一项，读屏就不播报、键盘用户就滚不到错误正文——这类缺失不报错、不影响渲染，
 * fireEvent 又永远点得到，只能静态钉。
 *
 * 口径：
 * 1. 结构字面量只允许出现在 src/components/InlineError.tsx，第二份手抄直接红；
 * 2. 组件自己必须带齐无障碍属性与复制按钮（防「抽完了但抽漏了」）；
 * 3. 接线点有数量下限（防守卫永真、也防站点悄悄退回手抄）；
 * 4. styles.css 的 .inline-error* 规则与 zh/en 的 label 文案都还在（反向死钩子保护）。
 * 5. 波35（R58）：title/retryLabel/copyLabel 的兜底文案只许写在组件里各一次，
 *    站点再攒一个私有「标签包」（当年的 inlineErrorLabels）即红——同一句「操作失败」被铺 4 遍，
 *    新站点想复用还得再抄一份。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource, sourceFiles, loadLocale } from "./scanUtils";

const IMPLEMENTATION = "src/components/InlineError.tsx";
/** 结构字面量：出现第二份就说明有人又开始手抄了。 */
const STRUCTURE = /"inline-error-(?:head|title|actions|body)"/g;
/** 组件接线点。 */
const WIRED = /<InlineError\b/g;
/** 纯一句话的短提示：没有 head/body 结构，套组件会凭空多出复制按钮和详情框，保留裸 div。 */
const SHORT_HINT_SITES = [
  "src/components/SettingsView.tsx|settings.openFolderFailed",
  "src/components/SettingsView.tsx|settings.clearCacheFailed",
];
/** 裸容器块：用来区分「短提示」与「又手抄了一整套结构」。 */
const RAW_BLOCK = /<div className="inline-error[^"]*" role="alert">([\s\S]{0,400}?)<\/div>/g;
/** 站点私有「标签包」：`const xxxLabels = { title: … }`。波35 起只许依赖组件默认值，命中即红。 */
const PRIVATE_LABEL_BUNDLE = /const\s+\w*(?:Labels|LABELS)\w*\s*=\s*\{[^}]*\btitle:/g;

function hitsIn(re: RegExp, source: string): number[] {
  const hits: number[] = [];
  for (const match of source.matchAll(re)) hits.push(match.index ?? 0);
  return hits;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function report(file: string, source: string, hits: number[]): string[] {
  return hits.map((at) => {
    const line = lineOf(source, at);
    return `${file}:${line}: ${source.split("\n")[line - 1].trim().slice(0, 100)}`;
  });
}

describe("内联错误块单一出口（波28 R48）", () => {
  const files = sourceFiles();
  const component = readScannedSource(IMPLEMENTATION);

  it("结构字面量只许写在 InlineError.tsx 里", () => {
    const violations = files
      .filter((file) => file !== IMPLEMENTATION)
      .flatMap((file) => {
        const source = readScannedSource(file);
        return report(file, source, hitsIn(STRUCTURE, source));
      });
    expect(violations, `又长出第二份手抄了，改用 <InlineError …/>：\n${violations.join("\n")}`).toEqual([]);
  });

  it("裸 .inline-error 容器只许是登记过的短提示", () => {
    const copies: string[] = [];
    const hints: string[] = [];
    for (const file of files) {
      if (file === IMPLEMENTATION) continue;
      const source = readScannedSource(file);
      for (const match of source.matchAll(RAW_BLOCK)) {
        const inner = match[1] ?? "";
        const line = lineOf(source, match.index ?? 0);
        const key = inner.match(/t\(\s*"([^"]+)"/)?.[1] ?? "(无文案)";
        if (/inline-error-head|inline-error-body/.test(inner)) copies.push(`${file}:${line}: ${key}`);
        else hints.push(`${file}|${key}`);
      }
    }
    expect(copies, `整块结构又手抄了，换 <InlineError …/>：\n${copies.join("\n")}`).toEqual([]);
    expect(hints.sort(), "短提示登记表与实码不一致：新增要么改用组件，要么在这里登记并说明为什么不该套组件").toEqual(
      [...SHORT_HINT_SITES].sort()
    );
  });

  it("组件本体必须带齐播报与键盘可达属性", () => {
    for (const needle of [
      'role="alert"',
      "tabIndex={0}",
      'role="region"',
      "common.errorDetail",
      "<CopyButton",
      "common.retry",
      "common.copyError",
    ]) {
      expect(component, `InlineError.tsx 少了 ${needle}`).toContain(needle);
    }
  });

  it("接线点数量有下限，守卫不会跑着跑着变成永真", () => {
    const wired = files.flatMap((file) => hitsIn(WIRED, readScannedSource(file)));
    expect(wired.length, "<InlineError 接线点低于预期，可能有人把站点删了或退回手抄").toBeGreaterThanOrEqual(12);
  });

  it("站点专属类仍经 extraClassName 挂在组件上", () => {
    // 这两个类只用来调 margin，一旦接线丢了，styles.css 里的规则就成了死钩子
    const cases: [string, string][] = [
      ["src/components/AppDataBackupPanel.tsx", "app-data-backup-error"],
      ["src/components/BackupView.tsx", "backup-webdav-error"],
    ];
    for (const [file, cls] of cases) {
      expect(readScannedSource(file), `${file} 的 extraClassName="${cls}" 接线丢了`).toContain(`extraClassName="${cls}"`);
    }
  });

  it("styles.css 的 .inline-error* 规则与两个语种的 label 都还在", () => {
    const css = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const cls of ["inline-error", "inline-error-head", "inline-error-title", "inline-error-actions", "inline-error-body"]) {
      expect(css, `styles.css 里 .${cls} 被删了，InlineError 会变成无样式块`).toContain(`.${cls}`);
    }
    expect(css, ".inline-error-body 的 :focus-visible 描边不能丢").toMatch(/\.inline-error-body:focus-visible[^{]*\{[^}]*outline:/);
    ["zh-CN.json", "en-US.json"].forEach((file) => {
      const locale = loadLocale(file);
      for (const key of ["common.retry", "common.copyError", "common.errorDetail"]) {
        expect(locale[key], `${file} 缺 ${key}`).toBeTruthy();
      }
    });
  });

  it("三个标签的默认文案只在组件里定义一次", () => {
    for (const [needle, why] of [
      ["title ?? t(", "默认标题的兜底写法变了"],
      ["retryLabel ?? t(", "重试按钮的兜底写法变了"],
      ["copyLabel ?? t(", "复制按钮的兜底写法变了"],
    ] as [string, string][]) {
      expect(component, `${why}：InlineError.tsx 里找不到 ${needle}`).toContain(needle);
    }
    expect(component, "默认值一旦生效，title 必须是可选属性").toContain("title?: string;");

    // 站点侧再攒「标签包」就是把同一句文案铺 N 遍（波35 删掉的 inlineErrorLabels 形态）。
    const bundles = files
      .filter((file) => file !== IMPLEMENTATION)
      .flatMap((file) => {
        const source = readScannedSource(file);
        return report(file, source, hitsIn(PRIVATE_LABEL_BUNDLE, source));
      });
    expect(bundles, `站点又攒了私有标签对象，删掉并依赖组件默认值：\n${bundles.join("\n")}`).toEqual([]);
  });

  it("ConfigBrowser 的私有标签对象不许长回来", () => {
    const source = readScannedSource("src/components/ConfigBrowser.tsx");
    expect(source, "inlineErrorLabels 已被组件默认值取代").not.toContain("inlineErrorLabels");
    expect(source, "标题由组件兜底，站点不该再自己引 common.operationFailed").not.toContain('t("common.operationFailed")');
    for (const file of ["zh-CN.json", "en-US.json"]) {
      expect(loadLocale(file)["common.operationFailed"], `${file} 缺 common.operationFailed，默认标题会渲染成 undefined`).toBeTruthy();
    }
  });
});

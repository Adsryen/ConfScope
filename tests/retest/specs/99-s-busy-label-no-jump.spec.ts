// 轮67 R67-WP7 立，轮74 A3 换实现：会换文案的按钮，忙态那一帧宽度不许跳。
//
// 缺陷一开始长这样（修前真机读数见 /tmp/cs/wp7-probe.txt）：忙态写死一个「…」，
// 在 .btn 下实测只有 3px——按钮从 82 塌成一条缝，用户分不清是「在忙」还是「点坏了」。
// 轮67 的修法分两步：① 忙态换成完整文案（走 locale）；② 给那颗按钮钉 min-width 地板。
//
// 轮74 真机复测发现②这套地板本身是个新缺陷：
//   · 106px 是按「清理缓存」一颗按钮、英文档一种语种量出来的；
//   · 同一族里 134px 的「清除本机版本历史」挂上它，忙态反而从 134 塌到 106（−28px）；
//   · 会跳的「迁移凭据」根本没挂这个 class（82→80）；
//   · 只禁用不换文案的那几颗（更改位置… / 打开）点下去 1~3s 屏幕上毫无信号。
// 现在的地板由 DOM 自己提供：两档文案同占一格（BusyLabel + .busy-label-stack），
// 宽度恒等于较宽的一档，中英文、长短文案都自适应，不再有任何写死的像素。
//
// 为什么必须真机量：宽度是 font/padding/letter-spacing 算出来的，jsdom 一律给 0。
// 静态那一半（文案来自 locale、不许再出现 min-width 地板）在最后一节，另有
// tests/ux/busyLabelsStackBothStates.test.ts 盯「所有会换文案的按钮都走 BusyLabel」。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// playwright 的工作目录是 tests/retest，静态那一半必须按文件位置取仓库根，不能吃 cwd
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sourceFile = (rel: string) => readFileSync(join(PROJECT_ROOT, rel), "utf8");
// `retest` 是本项目 fixture（见 ./retestTest），必须从它拿 test，不能直接用 @playwright/test
import { expect, test } from "./retestTest";
import type { Page } from "@playwright/test";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";

interface SwapReading {
  locale: string;
  /** 哪一颗按钮（节 + 可见文案），只进报告，不参与判定 */
  button: string;
  restLabel: string;
  busyLabel: string;
  /** 静息渲染宽 */
  rest: number;
  /** 忙态那一帧的渲染宽 */
  busy: number;
  /** 摘掉「另一档也占一格」之后的忙态宽——有人退回单标签就是这个数 */
  busyWithoutStack: number;
  /** 忙态那一帧文字有没有被截断 */
  busyOverflow: boolean;
  /** 两档文案在 DOM 里的顺序（证明两档都真的在场） */
  options: string[];
  /** 静息帧的 data-shown / aria-hidden 读数（读屏只许念当前那一档） */
  shownAtRest: string[];
  hiddenAtRest: string[];
  /** 还原后的宽度，用来证明探针自己没留下痕迹 */
  restored: number;
}

/**
 * 浏览器侧：找到那颗带 BusyLabel 的按钮，量静息宽 → 翻到忙态那一帧再量 → 还原。
 * 翻页的做法是改 data-shown（两档本来都在 DOM 里），不是往按钮上贴文本——
 * 贴文本那种量法量的其实是「min-width 地板有没有生效」，替不了现在的机制。
 */
function measureSwap(args: [string, string, string, string]): SwapReading {
  const [section, restLabel, busyLabel, button] = args;
  const out: SwapReading = {
    locale: "",
    button,
    restLabel,
    busyLabel,
    rest: -1,
    busy: -1,
    busyWithoutStack: -1,
    busyOverflow: false,
    options: [],
    shownAtRest: [],
    hiddenAtRest: [],
    restored: -1,
  };
  const text = (el: Element) => (el.textContent ?? "").trim();
  const buttons = Array.from(document.querySelectorAll<HTMLElement>(`${section} button`));
  const target = buttons.find((b) => {
    const options = Array.from(b.querySelectorAll<HTMLElement>(".busy-label-option"));
    return options.length === 2 && text(options.find((o) => o.getAttribute("data-shown") === "true") ?? b) === restLabel;
  });
  if (!target) return out;
  const options = Array.from(target.querySelectorAll<HTMLElement>(".busy-label-option"));
  const width = () => Math.round(target!.getBoundingClientRect().width);
  const setShow = (want: string) => options.forEach((o) => o.setAttribute("data-shown", text(o) === want ? "true" : "false"));

  out.options = options.map(text);
  out.shownAtRest = options.map((o) => o.getAttribute("data-shown") ?? "null");
  out.hiddenAtRest = options.map((o) => o.getAttribute("aria-hidden") ?? "null");
  out.rest = width();

  setShow(busyLabel);
  out.busy = width();
  out.busyOverflow = target.scrollWidth > target.clientWidth + 1;
  // 摘掉机制：不再让另一档占格（等价于有人把 BusyLabel 换回单个文本节点）
  const offscreen = options.find((o) => o.getAttribute("data-shown") === "false");
  const previousDisplay = offscreen ? offscreen.style.display : "";
  if (offscreen) offscreen.style.display = "none";
  out.busyWithoutStack = width();
  if (offscreen) offscreen.style.display = previousDisplay;

  setShow(restLabel);
  out.restored = width();
  return out;
}

/** 按 `命名空间.键名` 取文案：判据必须盯 locale 里的真值，别再抄一遍字符串。 */
function localeCopy(locale: "zh-CN" | "en-US", restKey: string, busyKey: string) {
  const doc = JSON.parse(sourceFile(`src/locales/${locale}.json`)) as Record<string, Record<string, string>>;
  const pick = (key: string) => {
    const [ns, name] = key.split(".");
    return doc[ns][name];
  };
  return { rest: pick(restKey), busy: pick(busyKey) };
}

async function openSettings(page: Page, retest: unknown, locale: "zh-CN" | "en-US") {
  await installRetestBridge(page, retest);
  await republishRetestData();
  // 语种在导航前就写好：i18n 只在 Provider 初始化时读一次 localStorage.locale
  await page.addInitScript((value) => window.localStorage.setItem("locale", value), locale);
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await navigate(page, locale === "en-US" ? "Settings" : "设置");
  await page.waitForSelector(".settings-workbench");
  await page.waitForTimeout(900);
}

/** 两颗在纯浏览器构建里也一定渲染的换文案按钮（数据根那几颗要 Go 绑定，真机由 retest 侧的 Go 跑覆盖）。 */
const CASES = [
  { key: "clearCache", section: "#settings-developer", restKey: "settings.clearCache", busyKey: "settings.clearingCache" },
  { key: "migrateCredentials", section: "#settings-credentials", restKey: "settings.migrateCredentials", busyKey: "settings.migratingCredentials" },
];

for (const locale of ["zh-CN", "en-US"] as const) {
  test(`R67-WP7/轮74 A3 ${locale}：换文案的按钮忙态一帧不跳`, async ({ page, retest }) => {
    test.setTimeout(240_000);
    await openSettings(page, retest, locale);

    for (const item of CASES) {
      const { rest, busy } = localeCopy(locale, item.restKey, item.busyKey);
      expect(busy, `${locale} 缺 ${item.busyKey}`).toBeTruthy();
      expect(busy).not.toBe(rest);

      const reading = await page.evaluate(measureSwap, [item.section, rest, busy, item.key] as [string, string, string, string]);
      reading.locale = locale;
      console.log(JSON.stringify(reading));

      expect(reading.rest, `${item.key}：找不到带 BusyLabel 的按钮（${rest}），后面全是空断言`).toBeGreaterThan(0);
      expect(reading.options, `${item.key}：两档文案没有都在 DOM 里，宽度地板无从谈起`).toEqual([rest, busy]);
      expect(Math.abs(reading.rest - reading.busy), `${item.key}：忙态一帧宽度从 ${reading.rest} 跳到 ${reading.busy}`).toBeLessThanOrEqual(1);
      expect(reading.busyOverflow, `${item.key}：忙态文案被截断了（${busy} 放不下）`).toBe(false);
      // 牙：摘掉「另一档也占一格」就必须跳——证明这条判据真的在盯机制本身，不是盯一个恒真的宽度
      expect(reading.busyWithoutStack, `${item.key}：摘掉机制仍是 ${reading.busyWithoutStack}，说明地板不是 BusyLabel 给的`).toBeLessThan(
        reading.busy
      );
      // 还原干净（探针不许留下痕迹）
      expect(reading.restored, `${item.key}：量完没还原，静息宽已经变了`).toBe(reading.rest);
      // 读屏只念当前那一档：另一档必须同时是 data-shown=false 与 aria-hidden=true
      expect(reading.shownAtRest, `${item.key}：静息帧的 data-shown 不对`).toEqual(["true", "false"]);
      expect(reading.hiddenAtRest, `${item.key}：不可见那一档没被摘出可访问名，读屏会把两个状态名一起念`).toEqual(["null", "true"]);
      // 浏览器算出来的可访问名才是地面真相：另一档留在 DOM 里但不许进名字
      const button = page.locator(`${item.section} button:has(.busy-label-stack)`).filter({ hasText: rest }).first();
      await expect(button, `${item.key}：静息帧的可访问名掺进了忙态文案`).toHaveAccessibleName(rest);
    }
  });
}

// 静态那一半：文案仍来自 locale，且轮67 那套写死的像素地板不许回来。
test("R67-WP7/轮74 A3 忙态文案来自 locale，写死的宽度地板已收掉", () => {
  const source = sourceFile("src/components/SettingsView.tsx");
  expect(source, "忙态文案不走 locale 了").toContain('busyText={t("settings.clearingCache")}');
  expect(source, "静息文案不走 locale 了").toContain('idle={t("settings.clearCache")}');
  expect(source, "忙态又用硬编码符号了").not.toMatch(/cacheBusy\s*\?\s*["'“‘]/);
  expect(source, "又退回不换文案的写法（点下去毫无信号，轮74 A4）").not.toMatch(/\{cacheBusy \? t\("settings\.clearingCache"\) : t\("settings\.clearCache"\)\}/);

  const css = sourceFile("src/styles.css");
  expect(css, "按一颗按钮量出来的 min-width 地板又回来了").not.toMatch(/\.settings-busy-btn/);
  expect(css, "两档同占一格这条机制被删了").toMatch(/\.busy-label-option\[data-shown="false"\]\s*\{\s*visibility:\s*hidden\s*;\s*\}/);
});

// 轮67 R67-WP7：「清理缓存」的忙态文案不许让按钮宽度跳一下（真机量宽）。
//
// 缺陷长什么样（修前真机读数见 /tmp/cs/wp7-probe.txt）：忙态写的是硬编码一个「…」，
// 在 .btn 下实测只有 3px——按钮从 82px 塌成一条缝。用户点了「确定」之后，
// 眼前那颗按钮缩成一个点，看不出是「正在清理」还是「点坏了」，于是回头再点一次。
//
// 修法是两步，缺一不可，所以两条都钉：
//   ① 忙态换成完整文案（走 locale，不再硬编码省略号）；
//   ② 给这颗按钮一条 min-width 地板（= 最宽静息值 + 4px 余量）。
// 只做①还是会跳：en 静息 "Clear Cache" 102 → 忙态 "Clearing..." 89，一帧缩 13px。
//
// 为什么必须真机量：宽度是 font/padding/letter-spacing 算出来的，jsdom 一律给 0，
// 静态守卫只能钉「文案来自 locale」这一半，钉不住「跳不跳」。
import { readFileSync, writeFileSync } from "node:fs";
// `retest` 是本项目 fixture（见 ./retestTest），必须从它拿 test，不能直接用 @playwright/test
import { expect, test } from "./retestTest";
import type { Page } from "@playwright/test";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";

const SECTION = "#settings-developer";

interface WidthReading {
  locale: string;
  restLabel: string;
  busyLabel: string;
  /** 静息实际渲染宽（含 min-width 地板）。 */
  rest: number;
  /** 忙态文案渲染宽（含地板）。 */
  busy: number;
  /** 摘掉地板后的两档宽度，用来看「地板到底有没有在干活」。 */
  restNoFloor: number;
  busyNoFloor: number;
  /** 忙态那一帧文字有没有被地板以外的因素截断（scrollWidth 超出 clientWidth）。 */
  busyOverflow: boolean;
  /** 渲染出来的静息文字是否等于 locale 里的那个值（i18n 真接上了）。 */
  rendered: string;
  /** 关闭整条守卫的牙：地板值与最宽静息值的关系。 */
  minWidth: string;
}

/**
 * 浏览器侧：把忙态文案临时铺到真按钮上量宽，量完原样还原节点。
 * 用 replaceChildren 而不是 textContent=，是为了把 React 自己那个文本节点原封不动放回去。
 */
function measureButton(args: [string, string, string]): WidthReading {
  const [restLabel, busyLabel, section] = args;
  const buttons = Array.from(document.querySelectorAll<HTMLElement>(`${section} button`));
  const button = buttons.find((b) => (b.textContent ?? "").trim() === restLabel);
  if (!button) return { locale: "", restLabel, busyLabel, rest: -1, busy: -1, restNoFloor: -1, busyNoFloor: -1, busyOverflow: false, rendered: "", minWidth: "MISSING" };
  const original = Array.from(button.childNodes);
  const widthWith = (label: string) => {
    button.replaceChildren(document.createTextNode(label));
    const rect = button.getBoundingClientRect();
    const overflow = button.scrollWidth > button.clientWidth + 1;
    return { width: Math.round(rect.width), overflow };
  };
  // 先取用户真正看到的静息文案：改过文本之后再读就成了忙态文案（上一版就是这么读错的）
  const rendered = (button.textContent ?? "").trim();
  const rest = widthWith(restLabel);
  const busy = widthWith(busyLabel);
  // 还原静息文案，再摘掉地板量一次：这一档只用来证明「地板在干活」，不参与判定
  button.replaceChildren(...original);
  const floor = button.style.minWidth;
  button.style.minWidth = "0px";
  const restNoFloor = widthWith(restLabel);
  const busyNoFloor = widthWith(busyLabel);
  button.style.minWidth = floor;
  button.replaceChildren(...original);
  return {
    locale: "",
    restLabel,
    busyLabel,
    rest: rest.width,
    busy: busy.width,
    restNoFloor: restNoFloor.width,
    busyNoFloor: busyNoFloor.width,
    busyOverflow: busy.overflow,
    rendered,
    minWidth: getComputedStyle(button).minWidth,
  };
}

function localeCopy(locale: "zh-CN" | "en-US") {
  const doc = JSON.parse(readFileSync(`src/locales/${locale}.json`, "utf8")) as {
    settings: Record<string, string>;
  };
  return {
    rest: doc.settings.clearCache,
    busy: doc.settings.clearingCache,
  };
}

async function openSettings(page: Page, retest: unknown, locale: "zh-CN" | "en-US") {
  await installRetestBridge(page, retest);
  await republishRetestData();
  // 语种在导航前就写好：i18n 只在 Provider 初始化时读一次 localStorage.locale
  await page.addInitScript((value) => window.localStorage.setItem("locale", value), locale);
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await navigate(page, locale === "en-US" ? "Settings" : "设置");
  await page.waitForSelector(".settings-workbench");
  await page.waitForTimeout(900);
}

const readings: WidthReading[] = [];

test("R67-WP7 中文档：清理缓存静息→忙态一帧不跳", async ({ page, retest }) => {
  test.setTimeout(240_000);
  const { rest, busy } = localeCopy("zh-CN");
  expect(busy, "zh-CN 缺 settings.clearingCache").toBeTruthy();
  expect(busy).not.toBe(rest);

  await openSettings(page, retest, "zh-CN");
  const reading = await page.evaluate(measureButton, [rest, busy, SECTION] as [string, string, string]);
  reading.locale = "zh-CN";
  readings.push(reading);
  writeFileSync("/tmp/cs/wp7-readings.txt", JSON.stringify(readings, null, 2));

  expect(reading.rest, "找不到渲染静息文案的按钮，后面全是空断言").toBeGreaterThan(0);
  expect(reading.rendered, "静息文案与 locale 不一致").toBe(rest);
  expect(Math.abs(reading.rest - reading.busy), `忙态一帧宽度从 ${reading.rest} 跳到 ${reading.busy}`).toBeLessThanOrEqual(1);
  expect(reading.busyOverflow, `忙态文案被截断了（${reading.busyLabel} 放不下）`).toBe(false);
  // 地板真的在干活：摘掉它就会跳（修前实测 82 vs 80）。这条不是判据，是把「假绿」暴露出来
  expect(reading.minWidth, "按钮没有 min-width 地板").not.toBe("0px");
  expect(reading.restNoFloor, `摘掉地板后静息宽 ${reading.restNoFloor}，说明地板其实没生效`).toBeLessThan(reading.rest);
});

test("R67-WP7 英文档：Clear Cache → Clearing... 同样不跳", async ({ page, retest }) => {
  test.setTimeout(240_000);
  const { rest, busy } = localeCopy("en-US");
  expect(busy, "en-US 缺 settings.clearingCache").toBeTruthy();

  await openSettings(page, retest, "en-US");
  const reading = await page.evaluate(measureButton, [rest, busy, SECTION] as [string, string, string]);
  reading.locale = "en-US";
  readings.push(reading);
  writeFileSync("/tmp/cs/wp7-readings.txt", JSON.stringify(readings, null, 2));

  expect(reading.rest, "找不到渲染静息文案的按钮，后面全是空断言").toBeGreaterThan(0);
  expect(reading.rendered, "静息文案与 locale 不一致").toBe(rest);
  // 这一档是地板存在的理由：只把「…」换成 "Clearing..." 而不钉地板，en 静息 102 → 忙态 89 缩 13px。
  expect(Math.abs(reading.rest - reading.busy), `忙态一帧宽度从 ${reading.rest} 跳到 ${reading.busy}`).toBeLessThanOrEqual(1);
  expect(reading.busyOverflow, `忙态文案被截断了（${reading.busyLabel} 放不下）`).toBe(false);
  // 方向别写反：摘掉地板是「变窄」，所以拿静息减忙态。
  expect(reading.restNoFloor - reading.busyNoFloor, `摘掉地板后应从 ${reading.restNoFloor} 缩到 ${reading.busyNoFloor}（缩不到 8px 说明地板没生效）`).toBeGreaterThanOrEqual(8);
});

// 静态那一半：忙态文案必须走 locale。真机量宽能守住「不跳」，守不住「谁把文案又改回 …」——
// 改回省略号后宽度只要仍然 >= 地板，两条判据都会绿灯。
test("R67-WP7 忙态文案来自 locale，不写死省略号", () => {
  const source = readFileSync("src/components/SettingsView.tsx", "utf8");
  expect(source, "忙态又用硬编码符号了").toContain("{cacheBusy ? t(\"settings.clearingCache\") : t(\"settings.clearCache\")}");
  expect(source, "忙态不许再回到硬编码省略号（实测 3px，按钮塌成一条缝）").not.toMatch(/cacheBusy\s*\?\s*["'“‘]/);
  const css = readFileSync("src/styles.css", "utf8");
  expect(css, "地板规则被删了").toMatch(/\.settings-busy-btn\s*\{[^}]*min-width:\s*106px/);
});

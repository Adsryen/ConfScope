/**
 * 原生刷新快捷键接管 + 一次性意图不落存储（轮45 R01/R02，用例号 NS-01…NS-03、SA-01）。
 *
 * 先把这套 harness 能证什么说清楚（轮45 探针 A 实测，别把它当成万能）：
 * CDP 注入的 F5/Ctrl+R **不会**让 headless chromium 触发浏览器级重载——连"完全没有拦截"的现状
 * 也是 navDelta=0，而同一趟里 `page.reload()` 自检一定能被内存标记检出（marker=GONE）。
 * 所以"刷新没发生"在这里只是弱证据，本用例钉的是**DOM 层的接管成立**：
 * 兜底监听收得到这些组合、把 defaultPrevented 置上了、Alt 逃生门和裸 r 打字没被吞。
 * WebView2 真机那一次人工验证仍挂在 prd.md 待办里，别拿这四条绿当"真机已验"。
 *
 * 监听顺序是这套断言的全部依据：window 上同阶段的监听按注册先后执行，App 的兜底在挂载
 * effect 里注册，所以探针只能在页面沉降之后用 page.evaluate 追加，读到的 defaultPrevented
 * 才是"兜底已经动过手"的证据。不能用 addInitScript——那会把探针排在 App 之前，读到的永远是
 * false（探针 A 就是这么量的，当时的 seen 全是 pre=false）。
 *
 * 分工（不要在真机里重复单测已经钉死的东西）：
 *  判据本身（哪些组合算刷新键）由 src/lib/reloadShortcut.test.ts 钉；
 *  接线在不在由 tests/ux/nativeReloadShortcutWiring.test.ts 钉；
 *  存储侧不变量由 tests/ux/diffSourcesPersistOnceOnly.test.ts 钉。这里补的是真机那四段：
 *  NS-01 四种刷新组合逐一被吞，且内存现场（搜索词 + 命中条数 + 打开的正文 + 行号）一格没动；
 *  NS-02 Ctrl+Alt+R 留给宿主，不许拦（这是开发者手敲重载的唯一逃生门）；
 *  NS-03 裸 r 仍是打字——把"为了拦刷新把输入框打死"这种修法挡在真机上；
 *  SA-01 启动自动比照常发生（行为等价），但跑完之后的任何一次持久化都不许把 diffAutoCompare 写回来。
 */
import { expect, type Page } from "@playwright/test";
import { test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";

const T = 30_000;
/** 播种数据里确实存在的配置名前缀（轮45 探针 B 实测：搜它得 2 条）。 */
const TERM = "svc-pay";

type Scene = Record<string, string | number>;
type ProbeHit = { combo: string; prevented: boolean; target: string; marker: string };

async function bootstrap(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
}

/**
 * 追加探针监听（必须在 App 挂载之后调用，理由见文件头）。
 * 顺带把 `__r45scene` 这个纯内存标记立起来：整页重载一定清掉它，DOM 拦截不会。
 */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __r45probe: ProbeHit[];
      __r45scene?: string;
    };
    w.__r45probe = [];
    w.__r45scene = "alive";
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      const mods = `${e.ctrlKey ? "C" : ""}${e.metaKey ? "M" : ""}${e.altKey ? "A" : ""}${e.shiftKey ? "S" : ""}`;
      const t = e.target as Element | null;
      const cls = t && typeof t.className === "string" ? t.className.trim().split(/\s+/).join(".") : "";
      w.__r45probe.push({
        combo: `${mods}:${e.key}`,
        prevented: e.defaultPrevented,
        target: t ? `${t.tagName}.${cls}` : "null",
        marker: typeof w.__r45scene === "string" ? w.__r45scene : "GONE(reloaded)",
      });
    });
  });
}

async function readProbe(page: Page): Promise<ProbeHit[]> {
  return page.evaluate(() => (window as unknown as { __r45probe: ProbeHit[] }).__r45probe.slice());
}

/** 内存现场读数：搜索词、命中条数、打开的正文与行号、正文里的标记。 */
async function readScene(page: Page): Promise<Scene> {
  return page.evaluate((): Scene => {
    const vis = (sel: string): number =>
      Array.from(document.querySelectorAll(sel)).filter((el) => !!(el as HTMLElement).offsetParent).length;
    const input = document.querySelector(".browser-search-input, .search-input.wide") as HTMLInputElement | null;
    const first = document.querySelector(".browser-item-id");
    const out: Scene = {
      searchValue: input ? input.value : "no-input",
      items: vis(".browser-item-id"),
      codeArea: vis(".code-area"),
      codeLines: vis(".code-line"),
      lineNumbers: vis(".code-ln"),
      marks: vis(".code-area mark"),
      firstItem: first ? (first.textContent || "").trim().slice(0, 48) : "none",
      contentChars: (document.querySelector(".code-area")?.textContent || "").length,
    };
    return out;
  });
}

/** 走到"搜出结果 + 打开一条正文"的现场，并装好探针。 */
async function openSceneWithProbe(page: Page): Promise<Scene> {
  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  const search = page.locator(".browser-search-input, .search-input.wide").first();
  await search.fill(TERM);
  await search.press("Enter");
  await expect(page.locator(".browser-item-id").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  await page.locator(".browser-item-id").filter({ visible: true }).first().click();
  await expect(page.locator(".code-area").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  await page.waitForTimeout(800);

  await installProbe(page);
  const scene = await readScene(page);
  // 档位自检：现场真的建起来了，否则后面的"没变"是拿两个空态在比
  expect(Number(scene.items), "搜索没出结果，后面的现场断言就没有意义").toBeGreaterThan(0);
  expect(Number(scene.codeArea), "正文没打开").toBe(1);
  expect(Number(scene.lineNumbers), "正文行号没渲染（轮44 的能力），现场不可信").toBeGreaterThan(0);
  return scene;
}

/** 按一个组合键，返回探针看到的最后一条 keydown（修饰键自己那条不算，见 combo）。 */
async function pressAndRead(page: Page, key: string, wantCombo: string): Promise<ProbeHit> {
  await page.keyboard.press(key);
  await page.waitForTimeout(400);
  const hits = await readProbe(page);
  const last = hits[hits.length - 1];
  expect(last, `页面根本没收到 ${key} 的 keydown（探针排在 App 之前？`).toBeTruthy();
  expect(last.combo, `${key} 到达页面时是 ${last.combo}，与预期的 ${wantCombo} 不是同一个组合`).toBe(wantCombo);
  return last;
}

async function readUiState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => JSON.parse(window.localStorage.getItem("cs.ui") || "{}") as Record<string, unknown>);
}

test("NS-01 F5/Ctrl+R/Ctrl+Shift+R/Ctrl+F5 全部被接管，内存现场一格没动", async ({ page, retest }) => {
  test.setTimeout(240_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  const before = await openSceneWithProbe(page);

  // 组合键 → 探针应当看到的 combo（playwright 的 press 会先送修饰键自己的 keydown，取最后一条）
  const combos: [string, string][] = [
    ["F5", ":F5"],
    ["Control+r", "C:r"],
    ["Control+Shift+r", "CS:r"],
    ["Control+F5", "C:F5"],
  ];
  for (const [key, combo] of combos) {
    const hit = await pressAndRead(page, key, combo);
    expect(hit.prevented, `${key} 漏给原生层了：兜底没有 preventDefault（target=${hit.target}）`).toBe(true);
    expect(hit.marker, `${key} 之后内存标记没了 = 这一趟真发生了整页重载`).toBe("alive");
    const after = await readScene(page);
    expect(after, `${key} 之后现场变了`).toEqual(before);
    console.log(`| ${key.padEnd(16)} | combo=${combo.padEnd(6)} | defaultPrevented=${hit.prevented} | 现场=${JSON.stringify(after)}`);
  }

  const hits = await readProbe(page);
  expect(hits.filter((h) => h.prevented).length, "四条刷新组合应当有 4 次 preventDefault").toBe(4);
  await page.screenshot({ path: "results/ns01-reload-guard.png", fullPage: true });
});

test("NS-02 Ctrl+Alt+R 是留给宿主/手敲重载的逃生门，不许拦", async ({ page, retest }) => {
  test.setTimeout(240_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  const before = await openSceneWithProbe(page);

  const hit = await pressAndRead(page, "Control+Alt+r", "CA:r");
  expect(hit.prevented, "带 Alt 的组合被兜底吞掉，开发者就没有手敲重载的路了").toBe(false);
  expect(await readScene(page), "逃生门按下去不该动现场").toEqual(before);

  // 放行一次之后兜底必须还在位（不能"让位"成卸载）
  const again = await pressAndRead(page, "F5", ":F5");
  expect(again.prevented, "Alt 放行之后 F5 也不拦了 = 监听被撤掉了").toBe(true);
  await page.screenshot({ path: "results/ns02-alt-escape.png", fullPage: true });
});

test("NS-03 搜索框里的裸 r 仍是打字，兜底不许贪到无修饰符的字母键", async ({ page, retest }) => {
  test.setTimeout(240_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await openSceneWithProbe(page);

  const search = page.locator(".browser-search-input, .search-input.wide").first();
  await search.click();
  await search.fill("");
  const hit = await pressAndRead(page, "r", ":r");
  expect(hit.prevented, "无修饰符的 r 被判成刷新键，输入框里就打不出 r 了").toBe(false);
  expect(hit.target, "按键应当落在搜索框里").toContain("search-input");
  await expect(search, "打字没落到输入框").toHaveValue("r", { timeout: 10_000 });

  // 大写在 CapsLock/Shift 下也照样是打字
  await search.press("R");
  await expect(search).toHaveValue("rR", { timeout: 10_000 });
  await page.screenshot({ path: "results/ns03-plain-r-types.png", fullPage: true });
});

test("SA-01 启动自动比照常跑，但 cs.ui 里再也查不到 diffAutoCompare", async ({ page, retest }) => {
  test.setTimeout(240_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);

  // 行为等价：种子里 mode=diff + 左右来源齐全 ⇒ 不需要存储里的标志也该自己比出一屏差异
  // （旧口径靠 diffAutoCompare:true 这个常驻标志，代价是探针 A2 量到的"每次加载白比一轮 + 4.6s"）
  await expect(page.locator(".diff-panel .diff-row").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  await expect(page.locator(".side-nav-item.active"), "启动页应当还停在配置对比").toContainText("配置对比");

  const ui0 = await readUiState(page);
  expect(ui0.mode, "种子态被改掉了，后面的断言就是在测别的现场").toBe("diff");
  expect(ui0).not.toHaveProperty("diffAutoCompare");
  expect(ui0.diffLeftConnId, "持久化该留的东西（比的是哪两个来源）不能一起删了").toBe("retest-a");
  expect(ui0.diffRightConnId).toBe("retest-b");

  // 回声室的复发方式是"再来一处把它写回去"：折叠侧栏 + 绕一趟浏览页，
  // 这两个动作各自都会重跑持久化 effect，标志一次都不许冒出来。
  await page.locator(".sidebar-toggle").click();
  await page.waitForTimeout(400);
  expect(await readUiState(page)).not.toHaveProperty("diffAutoCompare");
  // 再点开：侧栏收起时导航项只剩图标，navigate() 按文案点不动
  await page.locator(".sidebar-toggle").click();
  await page.waitForTimeout(400);

  await navigate(page, "配置浏览");
  await expect(page.locator(".browser-item-id").filter({ visible: true }).first()).toBeVisible({ timeout: T });
  await navigate(page, "配置对比");
  await page.waitForTimeout(1_200);

  const ui1 = await readUiState(page);
  expect(ui1).not.toHaveProperty("diffAutoCompare");
  expect(ui1.mode).toBe("diff");
  expect(ui1.diffLeftConnId).toBe("retest-a");
  console.log("[SA-01] 沉降后 cs.ui =", JSON.stringify(ui1));
  await page.screenshot({ path: "results/sa01-transient-intent.png", fullPage: true });
});

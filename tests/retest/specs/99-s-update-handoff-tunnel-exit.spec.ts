/**
 * 轮69：升级交接的忙碌闸门要「点得出名」并且「给得出出口」。
 *
 * 缺陷是用户 1.9.8 实机点「退出并安装」撞出来的：
 *   仍有操作在进行中，已阻止退出：
 *   仍有 1 条 SSH 隧道在线：c_mqze3n5l_19oeti
 * 两条都不对——① 内部连接 ID 用户认不出是哪条隧道；② 只说被挡住，没有任何可操作的出口，
 * 只能自己摸去 SSH 隧道页关掉，再回到关于页从头再点一遍。
 *
 * 为什么必须真机：闸门读的是 Go 侧隧道表（前端另存一份会漂），「关掉再继续」走的是
 * api/nacos 的 closeTunnelAndWait → StopSSHTunnel 绑定。jsdom 那三条钉的是文案与顺序，
 * 「产品真的把这条隧道关掉了吗」只能由桥内隧道表回读来证明——所以这里断言的是桥的读数，
 * 不是界面自己说满意。这条链路此前从没被真机走过：桥里 CheckForUpdates 恒回「已是最新」、
 * 隧道表恒空（现在由 setRetestUpdateCheck / setRetestActiveTunnels 按需播种，每用例重置）。
 */
import { expect, test } from "./retestTest";
import type { Page } from "@playwright/test";
import type { RetestState } from "../state";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { getRetestActiveTunnels, setRetestActiveTunnels, setRetestUpdateCheck } from "../bridge/retestBinding";
import { navigate, dismissStartupDialog } from "./ui";

/** Windows 安装版一档：唯一给「退出并安装」人工闸门的出路。 */
const UPDATE_CHECK = {
  hasUpdate: true,
  latestVersion: "9.9.9",
  currentVersion: "1.9.2",
  sourceName: "GitHub 官方",
  sourceUrl: "https://github.example/Adsryen/ConfScope/releases/download/v9.9.9/update.json",
  releaseNotes: "闸门点名",
  publishedAt: "2026-10-24T00:00:00Z",
  sha256: "abc",
  mandatory: false,
  checkedAt: "2026-10-24T00:00:00Z",
  error: "",
  platformKey: "windows-amd64-installer",
  fileName: "ConfScope-Setup-9.9.9.exe",
  handoff: "installer",
  downgraded: false,
  reason: "",
  downloadUrl: "https://download.example/ConfScope-Setup-9.9.9.exe",
};
const ARTIFACT = "C:\\Users\\retest\\AppData\\Local\\Temp\\confscope-update-retest.exe";
/** 播种连接里真的存在两条（cs.connections），隧道 ID 用它们的 id：点名才能翻出连接名。 */
const TUNNEL_A = "retest-a";
const TUNNEL_B = "retest-b";
const LABEL_A = "Retest Project / Development / Retest Nacos A";
const LABEL_B = "Retest Project / Sandbox / Retest Nacos B";

/** 走到「下载完成」的交接面板，返回关于页的作用域（保住活视图只匹配当前这页）。 */
async function openReadyHandoff(page: Page, retest: RetestState, tunnelIds: string[]) {
  await installRetestBridge(page, retest);
  // 桥内替身必须在 install 之后设：installRetestBridge 每个用例先把交接替身重置成基线。
  setRetestUpdateCheck(UPDATE_CHECK, ARTIFACT);
  setRetestActiveTunnels(tunnelIds);
  await page.goto("/");
  await dismissStartupDialog(page);
  await navigate(page, "关于");
  const about = page.locator(".page-surface.about-page");
  // 播种的 lastCheckAt 是 7 天前 ⇒ 进这页就自动查过一次，所以等按钮出现，不假设是谁触发的检查。
  await about.locator("button", { hasText: "下载并安装" }).first().click();
  const quit = about.locator("button", { hasText: "退出并安装" });
  await expect(quit).toBeVisible({ timeout: 20_000 });
  return about;
}

test("R69 闸门点名：正文是连接名，内部 ID 退到 title，并给得出出口", async ({ page, retest }) => {
  const about = await openReadyHandoff(page, retest, [TUNNEL_A]);
  await about.locator("button", { hasText: "退出并安装" }).click();

  const busy = about.locator(".update-busy");
  await expect(busy).toBeVisible({ timeout: 20_000 });
  const text = await busy.innerText();
  expect(text).toContain("仍有 1 条 SSH 隧道在线");
  expect(text, `正文应点名到连接，实际是：${text}`).toContain(LABEL_A);
  expect(text, `内部 ID 不该再出现在正文里：${text}`).not.toContain(TUNNEL_A);
  // ID 不是删掉而是降级：反馈问题时要有的可抄
  await expect(busy.locator(".update-busy-list li").first()).toHaveAttribute("title", TUNNEL_A);
  await expect(busy.locator("button", { hasText: "关闭这些隧道并继续" })).toBeVisible();

  // 被拦下的那一次绝不能已经退出：闸门仍然是硬的
  await expect(about.locator("button", { hasText: "正在退出并交给安装程序" })).toHaveCount(0);
  expect(getRetestActiveTunnels()).toEqual([TUNNEL_A]);
});

test("R69 闸门出口：一键关掉隧道后重走顺序，交接真的继续", async ({ page, retest }) => {
  const about = await openReadyHandoff(page, retest, [TUNNEL_A]);
  await about.locator("button", { hasText: "退出并安装" }).click();
  const close = about.locator("button", { hasText: "关闭这些隧道并继续" });
  await expect(close).toBeVisible({ timeout: 20_000 });
  await close.click();

  // 桥内隧道表被读回为空 = 产品真的带着正确的连接 ID 调到了 StopSSHTunnel，
  // 而不是只把界面文案换掉（界面随后也必须不再报忙碌，两边都要对上）。
  await expect.poll(() => getRetestActiveTunnels(), { timeout: 20_000 }).toEqual([]);
  await expect(about.locator(".update-busy")).toHaveCount(0);
  await expect(about.locator("button", { hasText: "正在退出并交给安装程序" })).toBeVisible({ timeout: 20_000 });
});

test("R69 多条隧道逐条关，不留一条再退出", async ({ page, retest }) => {
  const about = await openReadyHandoff(page, retest, [TUNNEL_A, TUNNEL_B]);
  await about.locator("button", { hasText: "退出并安装" }).click();

  const text = await about.locator(".update-busy").innerText();
  expect(text).toContain("仍有 2 条 SSH 隧道在线");
  expect(text, `两条都要点名：${text}`).toContain(LABEL_A);
  expect(text, `两条都要点名：${text}`).toContain(LABEL_B);
  expect(text).not.toContain(TUNNEL_A);

  await about.locator("button", { hasText: "关闭这些隧道并继续" }).click();
  await expect.poll(() => getRetestActiveTunnels(), { timeout: 20_000 }).toEqual([]);
  await expect(about.locator("button", { hasText: "正在退出并交给安装程序" })).toBeVisible({ timeout: 20_000 });
});

/**
 * r104 真机界面证据（S5）：主机密钥三条向量的界面形态。
 *
 * 为什么走复测桥替身而不是把容器 sshd2 的 host key 换掉：换 key 要动 c 与 retest 共用的容器，
 * 一次污染影响整批复测；p2 已用本机临时 sshd 实测过真握手路径，这里要证的是**界面呈现**
 * （弹层里读得到算法+指纹、拒绝不留半截连接、变更场景没有任何放行入口），替身能把三种裁决
 * 各自确定性喂给前端，读数可复现。
 *
 * 主机名里带一次性随机后缀：桥里的已信任集合随 vite 进程存活，固定主机名在同一个服务上跑第二遍
 * 时第一条向量就不再是「首次见」，弹层不出现，用例会以最难懂的方式红。
 */
import { test, expect } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { navigate, dismissStartupDialog } from "./ui";

const NONCE = Date.now().toString(36).slice(-4);
const HOST_UNKNOWN = `hk-unknown-${NONCE}.retest.invalid`;
const HOST_UNKNOWN_CANCEL = `hk-unknown-cancel-${NONCE}.retest.invalid`;
const HOST_CHANGED = `hk-changed-${NONCE}.retest.invalid`;
const PORT = "2223";
const KNOWN_HOSTS_PATH = "/tmp/confscope-retest/ssh/known_hosts";

/** 填一张新档案并点「测试 SSH」。 */
async function openFormAndTest(page: import("@playwright/test").Page, retest: import("../state").RetestState, host: string, name: string) {
  await installRetestBridge(page, retest);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await navigate(page, "SSH 隧道");
  await expect(page.locator(".ssh-manager-page")).toBeVisible({ timeout: 15_000 });
  await page.locator("button", { hasText: "新建 SSH 档案" }).first().click();

  const field = (label: string) => page.locator(".ssh-manager-page label.field").filter({ has: page.locator(`span:has-text('${label}')`) });
  await field("档案名称").locator("input").fill(name);
  await field("SSH 服务器地址").locator("input").fill(host);
  await field("SSH 用户名").locator("input").fill("retuser");
  await field("SSH 端口").locator("input").fill(PORT);
  // 空密码会被前端前置校验拦下，到不了探测这一步
  await field("SSH 密码").locator("input").fill("retest-fake-pw");
  await page.locator(".ssh-manager-page button", { hasText: "测试 SSH" }).first().click();
  await expect(page.locator(".modal-overlay .modal")).toBeVisible({ timeout: 30_000 });
}

test("S-HK-01 首次未知主机：确认弹层读出算法与指纹，确认后才拨号，第二次不再询问", async ({ page, retest }) => {
  await openFormAndTest(page, retest, HOST_UNKNOWN, `retest-hk-ok-${NONCE}`);

  const modal = page.locator(".modal-overlay .modal").first();
  await expect(modal.locator("h3")).toHaveText("首次连接：确认主机密钥");
  const details = modal.locator(".confirm-details li");
  await expect(details).toHaveCount(4);
  const lines = await details.allTextContents();
  console.log(`[S-HK-01] 弹层事实行 = ${JSON.stringify(lines)}`);
  expect(lines.join("\n")).toContain(`主机:端口: ${HOST_UNKNOWN}:${PORT}`);
  expect(lines.join("\n")).toContain("密钥算法: ssh-ed25519");
  expect(lines.join("\n")).toMatch(/SHA256 指纹: SHA256:[A-Za-z0-9/+]{20,}/);
  expect(lines.join("\n")).toContain(`记录文件: ${KNOWN_HOSTS_PATH}`);
  // 弹层打开时列表区已经播报了「未信任」，这条是用户不看弹层也能得到的原因
  const blocked = await page.locator(".ssh-manager-page .test-msg.err").first().innerText();
  console.log(`[S-HK-01] 确认前提示 = ${blocked.slice(0, 140)}`);
  expect(blocked).toContain("known_hosts 里没有这条记录");
  await page.screenshot({ path: "results/hk01-confirm-modal.png", fullPage: true });

  await modal.locator("button", { hasText: "确认并连接" }).click();
  await expect(page.locator(".ssh-manager-page .test-msg.ok")).toContainText("SSH 连接成功，耗时", { timeout: 30_000 });
  await expect(page.locator(".modal-overlay")).toHaveCount(0);
  await page.screenshot({ path: "results/hk01-after-confirm.png", fullPage: true });

  // 第二次：记录已在，探测直通，不再弹层（等 1.5s 覆盖一次探测往返）
  await page.locator(".ssh-manager-page button", { hasText: "测试 SSH" }).first().click();
  await page.waitForTimeout(1_500);
  await expect(page.locator(".modal-overlay")).toHaveCount(0);
  await expect(page.locator(".ssh-manager-page .test-msg.ok")).toContainText("SSH 连接成功，耗时", { timeout: 30_000 });
  await page.screenshot({ path: "results/hk01-second-connect-no-prompt.png", fullPage: true });
});

test("S-HK-02 拒绝首次确认：不建连、不写记录，下次仍然询问", async ({ page, retest }) => {
  await openFormAndTest(page, retest, HOST_UNKNOWN_CANCEL, `retest-hk-cancel-${NONCE}`);

  const modal = page.locator(".modal-overlay .modal").first();
  await expect(modal.locator("h3")).toHaveText("首次连接：确认主机密钥");
  await modal.locator("button", { hasText: "取消" }).click();
  await expect(page.locator(".modal-overlay")).toHaveCount(0);
  const rejected = await page.locator(".ssh-manager-page .test-msg.err").first().innerText();
  console.log(`[S-HK-02] 拒绝后提示 = ${rejected.slice(0, 120)}`);
  expect(rejected).toBe("未信任该主机密钥，未建立连接。");
  await page.screenshot({ path: "results/hk02-rejected.png", fullPage: true });

  // 拒绝不能留下半截记录：再测一次仍然是首次确认
  await page.locator(".ssh-manager-page button", { hasText: "测试 SSH" }).first().click();
  await expect(page.locator(".modal-overlay .modal")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".modal-overlay .modal").locator("h3")).toHaveText("首次连接：确认主机密钥");
  await page.screenshot({ path: "results/hk02-asks-again.png", fullPage: true });
  await page.locator(".modal-overlay .modal").locator("button", { hasText: "取消" }).click();
});

test("S-HK-03 指纹已变更：硬阻断，只一个「确定」，不提供任何放行入口", async ({ page, retest }) => {
  await openFormAndTest(page, retest, HOST_CHANGED, `retest-hk-changed-${NONCE}`);

  const modal = page.locator(".modal-overlay .modal").first();
  await expect(modal.locator("h3")).toHaveText("SSH 主机密钥已变更");
  const lines = await modal.locator(".alert-list li").allTextContents();
  const all = lines.join("\n");
  console.log(`[S-HK-03] 阻断弹层内容 = ${all.slice(0, 400)}`);
  expect(all).toContain("连接可能被中间人替换，已阻断");
  expect(all).toMatch(/记录指纹: SHA256:1{20,}/);
  expect(all).toContain("服务端现在出示的指纹");
  expect(all).toContain(`记录文件: ${KNOWN_HOSTS_PATH}`);
  // recordID 对齐 OpenSSH known_hosts：非 22 端口写成 [host]:port（internal/ssh/knownhosts.go recordID）
  expect(all).toContain(`要删除的记录: [${HOST_CHANGED}]:${PORT}`);
  // 放行入口一个都不许有：footer 只一颗按钮，全弹层找不到「仍然连接」类字样
  const footerButtons = modal.locator(".modal-footer button");
  await expect(footerButtons).toHaveCount(1);
  await expect(footerButtons.first()).toHaveText("确定");
  expect(all).not.toMatch(/仍然连接|继续连接|忽略|信任并连接/);
  await page.screenshot({ path: "results/hk03-changed-blocked.png", fullPage: true });

  await footerButtons.first().click();
  await expect(page.locator(".modal-overlay")).toHaveCount(0);
  // 变更场景绝不发起拨号：提示是阻断文案，不是连接失败文案
  const err = await page.locator(".ssh-manager-page .test-msg.err").first().innerText();
  console.log(`[S-HK-03] 关掉弹层后的提示 = ${err.slice(0, 160)}`);
  expect(err).toContain("SSH 主机密钥已变更");
  expect(err).not.toContain("SSH 连接失败");
  await page.screenshot({ path: "results/hk03-after-dismiss.png", fullPage: true });
});

// 轮142 C：SSH 档案的凭据迁进系统凭据库后，编辑表单必须把值读回来。
//
// 需求来源是用户原话「ssh隧道，我在编辑现有的档案配置的时候，我看不到里面配置的数据，连密码也看不到」。
// 为什么这条必须真机、jsdom 顶不了：触发条件是「设置页点迁移 → 凭据经桥写进库 → 本地只剩指针 →
// 重新打开档案表单」这四段串起来才复现，jsdom 侧的凭据库是注入进去的假 deps，走不到这条真实调用链。
// 断言全部落在拿得出手的证据上：本地数据里到底有没有明文、指针在不在、表单里到底读没读回值。
import { expect, test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";
import { loadRetestState } from "../state";

const state = loadRetestState();
const PASSWORD = "retest-hydrate-pw";

async function bootstrap(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
}

/** 档案表单里的字段：与 S5 同一认法（label.field 的直接子 span 是标题）。 */
function field(page: import("@playwright/test").Page, caption: string) {
  return page.locator(`label.field:has(> span:has-text("${caption}")) input`).first();
}

const readProfiles = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.localStorage.getItem("cs.sshProfiles") ?? "");

test("S17 SSH 档案凭据回显: 迁移后编辑读回、只改名字不把明文写回本地", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await bootstrap(page);
  await navigate(page, "SSH 隧道");
  await expect(page.locator(".ssh-manager-page").first()).toBeVisible({ timeout: 30_000 });

  const name = "retest-ssh-hydrate";
  await page.getByRole("button", { name: "新建 SSH 档案" }).click();
  await field(page, "档案名称").fill(name);
  await field(page, "SSH 服务器地址").fill(state.ssh?.host ?? "127.0.0.1");
  await field(page, "SSH 端口").fill(String(state.ssh?.port ?? 2222));
  await field(page, "SSH 用户名").fill(state.ssh?.username ?? "root");
  await field(page, "SSH 密码").fill(PASSWORD);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".test-msg.ok", { hasText: "SSH 配置档案已保存" }).first()).toBeVisible({ timeout: 10_000 });

  // 迁移前的基线：明文就在本地数据里，且还没有指针（下面两条断言都拿它作对照）
  const before = await readProfiles(page);
  expect(before).toContain(name);
  expect(before, "前置条件不成立：迁移前本地就该有明文，否则这条用例什么都没测").toContain(PASSWORD);
  expect(before).not.toContain("sshSecretRefs");

  // 走设置页那颗真按钮，不走 lib 直调：用户踩的就是这条路径
  await navigate(page, "设置");
  await page.getByRole("button", { name: "迁移凭据" }).click();
  await expect(page.locator(".test-msg.ok", { hasText: "已迁移" }).first()).toBeVisible({ timeout: 30_000 });

  const migrated = await readProfiles(page);
  expect(migrated, "迁移后本地数据里不许再留着明文口令").not.toContain(PASSWORD);
  expect(migrated, "迁移后必须留下指向凭据库的指针，否则值就是凭空丢了").toContain("sshSecretRefs");

  // 打开档案：值必须读回来——这正是用户报的那一条
  await navigate(page, "SSH 隧道");
  await page.locator(".ssh-profile-main", { hasText: name }).first().click();
  await expect(page.locator(".test-msg.ok", { hasText: "已从系统凭据库读回" }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".secret-source-note", { hasText: "保存在系统凭据库中" }).first()).toBeVisible();
  expect(await field(page, "SSH 密码").inputValue(), "编辑表单里看得到迁走的口令才算修完").toBe(PASSWORD);
  // 非凭据字段照常带出（原先整张表单是空的，用户才说「看不到里面配置的数据」）
  expect(await field(page, "SSH 服务器地址").inputValue()).toBe(state.ssh?.host ?? "127.0.0.1");
  expect(await field(page, "SSH 用户名").inputValue()).toBe(state.ssh?.username ?? "root");
  await page.screenshot({ path: "results/s17-ssh-profile-hydrated.png", fullPage: true });

  // 只改名字就保存：三路结算里「没动」那一路，绝不能把刚迁走的凭据以明文拉回本地（静默回退一次迁移）
  await field(page, "档案名称").fill(`${name}-renamed`);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.locator(".test-msg.ok", { hasText: "SSH 配置档案已保存" }).first()).toBeVisible({ timeout: 10_000 });
  const saved = await readProfiles(page);
  expect(saved).toContain(`${name}-renamed`);
  expect(saved, "只改名字保存却把明文写回本地 = 静默回退一次迁移").not.toContain(PASSWORD);
  expect(saved, "指针必须留着").toContain("sshSecretRefs");

  // 再开一次：库条目没被上一次保存弄丢，仍然读得回来
  await page.locator(".ssh-profile-main", { hasText: `${name}-renamed` }).first().click();
  await expect(page.locator(".test-msg.ok", { hasText: "已从系统凭据库读回" }).first()).toBeVisible({ timeout: 15_000 });
  expect(await field(page, "SSH 密码").inputValue(), "改名保存后凭据必须仍在库里").toBe(PASSWORD);
});

// 轮67 R67-WP6：口令框必须有自动填充语义、自己的回显开关、干净的可访问名（真机量）。
//
// 为什么必须真机：
// 1. 可访问名由浏览器的 accname 实现算出来。修前实测连接管理的 Nacos 密码框，Chromium 给出的是
//    「密码 显示密码」——同一只 label 里那颗回显按钮的 aria-label 被并进了输入框的名字，
//    读屏用户听完标题还要再听一遍按钮名（jsdom 侧 getByRole 同样算脏，两处独立复现）。
// 2. autocomplete / name 只有真浏览器会拿去配对自动填充，jsdom 里它们只是两个字符串属性。
// 3. 点开关后 type 是否真从 password 变成 text、焦点是否还留在输入框，只有真机能验。
//
// 覆盖面：设置页 8 个（应用数据备份面板）+ SSH 隧道 + 连接管理。
// BackupView 的 2 个要选中快照才渲染，交给组件用例与静态守卫（passwordFieldsUseSharedComponent）钉住。
import { expect, test } from "./retestTest";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog } from "./ui";
import { writeFileSync } from "node:fs";

interface PwdField {
  caption: string;
  type: string;
  name: string | null;
  autocomplete: string | null;
  labelledby: string | null;
  spellcheck: string | null;
  autocapitalize: string | null;
  toggles: number;
  pressed: string | null;
}

/** 量当前页面上所有口令输入框的语义与开关。按 name 也认一遍：回显后 type 会变成 text。 */
const readPwdFields = `(() => {
  const out = [];
  for (const input of Array.from(document.querySelectorAll("input"))) {
    const looksSecret = input.type === "password" || /(password|secret|token|passphrase)/i.test(input.name || "");
    if (!looksSecret) continue;
    const label = input.closest("label");
    const control = input.closest(".pwd-field");
    out.push({
      caption: (label?.querySelector("span")?.textContent ?? "").trim(),
      type: input.type,
      name: input.getAttribute("name"),
      autocomplete: input.getAttribute("autocomplete"),
      labelledby: input.getAttribute("aria-labelledby"),
      spellcheck: input.getAttribute("spellcheck"),
      autocapitalize: input.getAttribute("autocapitalize"),
      toggles: control ? control.querySelectorAll("button.pwd-toggle").length : 0,
      pressed: control?.querySelector("button.pwd-toggle")?.getAttribute("aria-pressed") ?? null,
    });
  }
  return out;
})()`;

const ALLOWED_AUTOCOMPLETE = new Set(["new-password", "current-password", "off"]);

function assertSemantics(fields: PwdField[], view: string): void {
  expect(fields.length, `${view} 没量到口令框，说明选择器漂了`).toBeGreaterThan(0);
  const names = new Set<string>();
  for (const field of fields) {
    const where = `${view}「${field.caption}」`;
    expect(field.name, `${where} 没有 name，浏览器只能靠猜来配对自动填充`).toBeTruthy();
    expect(names.has(field.name as string), `${where} 的 name「${field.name}」在同一屏重复，自动填充会填错框`).toBe(false);
    names.add(field.name as string);
    expect(ALLOWED_AUTOCOMPLETE.has(field.autocomplete ?? ""), `${where} autocomplete=${field.autocomplete}：要么没声明，要么不是合法档位`).toBe(true);
    // 名字钉死在标题上：按钮和输入框同在一个 label 里，不显式 labelledby 就会被并进名字
    expect(field.labelledby, `${where} 没有 aria-labelledby，读屏念到的名字会带上按钮`).not.toBeNull();
    expect(field.spellcheck, `${where} 没关拼写检查，口令会被画红线`).toBe("false");
    expect(field.autocapitalize, `${where} 没关首字母大写`).toBe("off");
    expect(field.toggles, `${where} 没有回显开关，敲错了自己看不见`).toBe(1);
  }
}

test("R67-WP6 设置页的口令框语义齐全且各自有名", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  await navigate(page, "设置");
  await page.waitForSelector(".settings-workbench");
  await page.waitForTimeout(900);

  const fields = (await page.evaluate(readPwdFields)) as PwdField[];
  writeFileSync("/tmp/cs/wp6-settings-fields.txt", JSON.stringify(fields, null, 2));
  expect(fields.length, "应用数据备份面板应有 8 个口令框").toBe(8);
  assertSemantics(fields, "设置页");

  // 每个框的可访问名必须恰好是它自己的标题（修前实测被并成「密码 显示密码」）
  for (const field of fields) {
    const caption = field.caption.replace(/[*?]+$/, "");
    await expect(page.getByRole("textbox", { name: caption, exact: true }), `「${caption}」按标题取不到唯一的框`).toHaveCount(1);
  }

  // 回显开关：type 真翻转、aria-pressed 跟着说真话、焦点留在输入框
  const first = fields[0].name as string;
  const target = page.locator(`input[name="${first}"]`);
  const toggle = page.locator(`input[name="${first}"] ~ button.pwd-toggle`);
  await target.focus();
  expect(await target.getAttribute("type"), "默认必须是遮住的").toBe("password");
  expect(await toggle.getAttribute("aria-pressed"), "初始态必须播报「未按下」").toBe("false");
  await toggle.click();
  expect(await target.getAttribute("type"), "点一次没换成可见文本").toBe("text");
  expect(await toggle.getAttribute("aria-pressed"), "回显后 aria-pressed 还说 false，等于对读屏撒谎").toBe("true");
  const focusKept = await page.evaluate(
    `document.activeElement === document.querySelector('input[name="${first}"]')`
  );
  expect(focusKept, "点回显后焦点被按钮抢走了，用户得重新点回输入框才能接着敲").toBe(true);
  await toggle.click();
  expect(await target.getAttribute("type"), "再点一次没有遮回去").toBe("password");

  // 加开关不许把面板撑出横向滚动
  const overflow = await page.evaluate(
    `(() => {
      const el = document.querySelector(".settings-panels");
      return el ? el.scrollWidth - el.clientWidth : 0;
    })()`
  );
  expect(overflow, "口令框加开关后 .settings-panels 出现横向溢出").toBeLessThanOrEqual(0);
});

test("R67-WP6 SSH 隧道与连接管理的口令框同样语义齐全", async ({ page, retest }) => {
  test.setTimeout(300_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await dismissStartupDialog(page);
  await page.setViewportSize({ width: 1280, height: 820 });
  const readings: Record<string, unknown> = {};

  await navigate(page, "SSH 隧道");
  await page.waitForTimeout(700);
  await page.locator("button", { hasText: /新建|新增|添加/ }).first().click();
  await page.waitForTimeout(600);
  const ssh = (await page.evaluate(readPwdFields)) as PwdField[];
  readings.ssh = ssh;
  assertSemantics(ssh, "SSH 隧道");

  await navigate(page, "连接管理");
  await page.locator(".conn-create-btn", { hasText: "新增来源" }).click();
  await page.waitForTimeout(700);
  const conn = (await page.evaluate(readPwdFields)) as PwdField[];
  readings.connections = conn;
  assertSemantics(conn, "连接管理");
  writeFileSync("/tmp/cs/wp6-other-fields.txt", JSON.stringify(readings, null, 2));

  // 连接管理的标题带必填星号与帮助符（FieldLabel 渲染），名字仍要恰好是「密码」
  const nacosPwd = conn.find((field) => field.caption.startsWith("密码"));
  expect(nacosPwd, "连接管理没量到 Nacos 密码框").toBeTruthy();
  await expect(page.getByRole("textbox", { name: "密码", exact: true })).toHaveCount(1);
});

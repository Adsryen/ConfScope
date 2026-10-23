/**
 * 本机版本历史的写入点只许有两个（轮67 WP-13，R57）。
 *
 * 为什么钉这件事：本机版本历史的价值全在「记的是不是实话」。写入点一旦散开，
 * 就会出现第三种口径——比如某个视图自己算摘要、某个链路线上漏记，
 * 用户在「历史变更」里看到的版本序列和真实发生的事就脱钩了，而且不会有人报错。
 *
 * 守卫钉四条：
 * 1. 绑定 AppendConfigRevision / ReadConfigRevisionsForKey 在产品代码里只有 src/lib/configRevisions.ts 能碰；
 * 2. 记 observed 的调用点只有 src/api/nacos.ts 的 getConfigDocument（全站唯一读取出口）；
 * 3. 记 confirmed-write 的调用点只有 src/lib/applyPlanExecution.ts（写后回读确认）；
 * 4. kind 两个字面量与「正文省略原因」字面量必须与 Go 侧 revisions 常量一致，两侧改其一就红；
 *    消费侧（本机历史面板）只许比较导出的常量，不许就地再写一遍 "too-large"——
 *    那正是「Go 改了值、前端还在认旧值，于是把有正文的版本说成被省略」的老路。
 *
 * 出口自己的函数定义不算调用点（否则守卫会在自己的定义上自红）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, stripComments } from "./scanUtils";

const OUTLET = "src/lib/configRevisions.ts";
const READ_SITE = "src/api/nacos.ts";
const WRITE_SITE = "src/lib/applyPlanExecution.ts";
const GUARD = "tests/ux/configRevisionWritePointsSingleSource.test.ts";
const GO_TRAIL = "internal/revisions/trail.go";
const LOCAL_PANEL = "src/components/LocalRevisionPanel.tsx";

function walk(dir: string, acc: string[]): string[] {
  for (const entry of readdirSync(`${PROJECT_ROOT}/${dir}`, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(rel, acc);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) acc.push(rel);
  }
  return acc;
}

/** 产品代码里（src 非测试）某个标识符的调用文件清单，出口自身的定义行剔除。 */
function callSites(identifier: string): string[] {
  const call = new RegExp(`\\b${identifier}\\s*\\(`);
  const definition = new RegExp(`export function ${identifier}\\s*\\(`);
  const hits: string[] = [];
  for (const rel of walk("src", [])) {
    if (rel === GUARD) continue;
    const text = stripComments(readFileSync(`${PROJECT_ROOT}/${rel}`, "utf8")).replace(definition, "");
    if (call.test(text)) hits.push(rel);
  }
  return hits.sort();
}

/** Go 侧常量真值：两个 kind 与正文省略原因的字面量。 */
function goKindConstants(): Record<string, string> {
  const text = readFileSync(`${PROJECT_ROOT}/${GO_TRAIL}`, "utf8");
  const out: Record<string, string> = {};
  for (const name of ["KindObserved", "KindConfirmedWrite", "ContentOmittedTooLarge"]) {
    const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`).exec(text);
    if (!match) throw new Error(`${GO_TRAIL} 里读不到 ${name}`);
    out[name] = match[1];
  }
  return out;
}

function outletText(): string {
  return readFileSync(`${PROJECT_ROOT}/${OUTLET}`, "utf8");
}

describe("本机版本历史写入点唯一事实源（R57）", () => {
  it("绑定只能由出口碰：产品代码里零直调 AppendConfigRevision", () => {
    const direct = callSites("AppendConfigRevision").filter((rel) => rel !== OUTLET);
    expect(direct, `绕过出口直调绑定：${direct.join(", ")}`).toEqual([]);
    expect(callSites("AppendConfigRevision"), "出口自己都没调绑定，说明接线断了").toEqual([OUTLET]);
    expect(callSites("ReadConfigRevisionsForKey").filter((rel) => rel !== OUTLET)).toEqual([]);
  });

  it("observed 只有唯一读取出口这一个写入点", () => {
    expect(callSites("observeLoadedDocument"), "除读取出口外还有人记 observed").toEqual([READ_SITE]);
    expect(outletText()).toMatch(/export function observeLoadedDocument\s*\(/);
  });

  it("confirmed-write 只有写后回读确认这一个写入点", () => {
    expect(callSites("recordConfirmedWrite"), "除回读确认外还有人记 confirmed-write").toEqual([WRITE_SITE]);
    expect(outletText()).toMatch(/export function recordConfirmedWrite\s*\(/);
  });

  it("写入点真的挂在读取出口与回读确认上，不是各留了一句空函数", () => {
    const read = stripComments(readFileSync(`${PROJECT_ROOT}/${READ_SITE}`, "utf8"));
    expect(read).toMatch(/observeLoadedDocument\(\s*conn\s*,\s*\{\s*namespace\s*,\s*group\s*,\s*dataId\s*\}/);
    const write = stripComments(readFileSync(`${PROJECT_ROOT}/${WRITE_SITE}`, "utf8"));
    expect(write).toMatch(/recordConfirmedWrite\(\s*targetConnection/);
    // 回读确认必须带 planId，否则来历升级（Go 侧 promote）拿不到回链
    expect(write).toMatch(/recordConfirmedWrite\([\s\S]{0,400}?planId\s*\)/);
  });

  it("kind 字面量与 Go 侧常量同值，两侧改其一就红", () => {
    const go = goKindConstants();
    const outlet = outletText();
    const observed = /CONFIG_REVISION_KIND_OBSERVED\s*=\s*"([^"]+)"/.exec(outlet)?.[1];
    const confirmed = /CONFIG_REVISION_KIND_CONFIRMED_WRITE\s*=\s*"([^"]+)"/.exec(outlet)?.[1];
    const omitted = /CONFIG_REVISION_CONTENT_OMITTED_TOO_LARGE\s*=\s*"([^"]+)"/.exec(outlet)?.[1];
    expect(observed).toBe(go.KindObserved);
    expect(confirmed).toBe(go.KindConfirmedWrite);
    expect(omitted, "正文省略原因的字面量与 Go 侧脱钩，面板会把有正文的版本说成省略了").toBe(
      go.ContentOmittedTooLarge
    );
  });

  it("消费侧只比较导出的常量，不再就地写第三份字面量", () => {
    const panel = stripComments(readFileSync(`${PROJECT_ROOT}/${LOCAL_PANEL}`, "utf8"));
    expect(panel).toMatch(/CONFIG_REVISION_CONTENT_OMITTED_TOO_LARGE/);
    expect(
      panel.includes('"too-large"') || panel.includes("'too-large'"),
      "本机历史面板里又写了一遍裸字面量，Go 改值时它不会跟着红"
    ).toBe(false);
  });

  it("出口保持吞错的降级：记不上历史不许影响读取与写入", () => {
    const outlet = outletText();
    expect((outlet.match(/catch/g) ?? []).length, "出口至少要吞掉同步抛与 reject 两类失败").toBeGreaterThanOrEqual(4);
    expect(outlet).toMatch(/\.catch\(\(\) => \{/);
  });

  it("自检：别处新增一个记 observed 的写入点必须判红", () => {
    const withExtra = [...callSites("observeLoadedDocument"), "src/components/Somewhere.tsx"].sort();
    expect(withExtra).not.toEqual([READ_SITE]);
  });

  it("自检：绕过出口直调绑定必须判红", () => {
    const direct = [...callSites("AppendConfigRevision"), "src/api/other.ts"].sort();
    expect(direct).not.toEqual([OUTLET]);
  });
});

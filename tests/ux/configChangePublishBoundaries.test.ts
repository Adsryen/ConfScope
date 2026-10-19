/**
 * 写后失效广播的发布/订阅边界（轮43 / AC2 / AC5）。
 *
 * 缺陷长什么样（取证见 `.trellis/tasks/10-19-10-19-ui-ux-43/prd.md`）：浏览页与对比页都被
 * `display:none` 保活，写路径却在另一棵子树（ApplyPlanView → 执行器）里改服务端。探针实测
 * 「变更执行完成」刚提示完，切回浏览页正文仍是执行前那一份（UI 43 行 / 服务端 45 行），
 * 新建的配置不在当前列表里，对比面板还挂着旧差异。
 *
 * 这轮补了一条总线（src/lib/configChangeBus.ts）。总线本身很难写错，会被写坏的是**边界**：
 * 1. 谁都能 publish —— 于是哪天有人给某个入口加一条「顺手广播一下」，dry-run、失败、
 *    甚至只读操作都会触发重取，用户看到的是「我什么都没干，界面自己乱跳」；
 * 2. 执行器直接 import 总线 —— 执行器就从一个可单测的纯函数变成带全局副作用的模块，
 *    轮43 那批 dry-run 不发布 / 逐项失败仍发布的单测会立刻失去意义；
 * 3. 谁都能 subscribe —— 保活页「隐藏期攒着、切回合并补做」是刻意的，别处再加一个订阅者
 *    直接同步取数，等于把保活省下的请求又还回去（ST-05 钉的就是这个收益）；
 * 4. 两页的时机策略相反：浏览页隐藏时不许发请求（只欠一笔），对比页却要在隐藏时也置位过期
 *    （回到前台时结果已过期必须仍然可见）。反着改任何一边都是静默回退，只能静态钉住。
 *
 * 口径：钉结构与名单，不钉行号、不钉用户文案字面量（轮43 定过）。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource, sourceFiles } from "./scanUtils";

const BUS = "src/lib/configChangeBus.ts";
const EXECUTOR = "src/lib/applyPlanExecution.ts";

/** 唯一合法的发布者：执行完成的那棵子树。 */
const PUBLISHERS = ["src/components/ApplyPlanView.tsx"];
/** 唯一合法的订阅者：被 display:none 保活的两个视图。 */
const SUBSCRIBERS = ["src/components/ConfigBrowser.tsx", "src/components/DiffView.tsx"];

/** 按括号配对截出 `subscribeConfigChanges(...)` 的回调块，用来检查时机策略。 */
function subscriberCallbacks(source: string): string[] {
  const blocks: string[] = [];
  const re = /\bsubscribeConfigChanges\(/g;
  let m = re.exec(source);
  while (m) {
    const open = source.indexOf("(", m.index);
    let depth = 0;
    let i = open;
    for (; i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(open, i + 1));
    re.lastIndex = i + 1;
    m = re.exec(source);
  }
  return blocks;
}

function filesMentioning(token: RegExp): string[] {
  return sourceFiles().filter((file) => file !== BUS && token.test(readScannedSource(file)));
}

describe("发布者只有一个", () => {
  it("src 下引用 publishConfigChange 的文件只有名单内的那一个", () => {
    const found = filesMentioning(/\bpublishConfigChange\b/);
    expect(found.sort(), "又多了一处广播点：写后失效会变成到处乱刷").toEqual(PUBLISHERS);
  });

  it("总线自己不许在定义之外调用发布", () => {
    const source = readScannedSource(BUS);
    const calls = source.match(/\bpublishConfigChange\s*\(/g) ?? [];
    expect(calls.length, "configChangeBus 里 publishConfigChange 只许出现一次（函数定义）").toBe(1);
  });

  it("执行器只交出可选回调，不碰总线", () => {
    const source = readScannedSource(EXECUTOR);
    expect(/\bpublishConfigChange\b/.test(source), "执行器直接 import 总线就变成带全局副作用的模块").toBe(false);
    expect(/\bsubscribeConfigChanges\b/.test(source)).toBe(false);
    expect(/onConfigsChanged\?\s*:/.test(source), "onConfigsChanged 不再是可选依赖，调用方就没法不接").toBe(true);
  });
});

describe("订阅者只有保活视图", () => {
  it("src 下订阅 write-after-change 的文件只有名单内的那两个", () => {
    const found = filesMentioning(/\bsubscribeConfigChanges\b/);
    expect(found.sort(), "多出未登记的订阅者：它的取数时机没人对着 ST-05 核过").toEqual(SUBSCRIBERS);
  });

  it("浏览页隐藏期只攒不发，切回前台合并补做", () => {
    const source = readScannedSource("src/components/ConfigBrowser.tsx");
    const blocks = subscriberCallbacks(source);
    expect(blocks.length, "浏览页的订阅点数量变了").toBe(1);
    const block = blocks[0];
    expect(/pendingStaleRef\.current\.push/.test(block), "隐藏期不再攒通知 = 每次写入都立刻取数，保活收益被换掉").toBe(true);
    expect(/activeRef\.current/.test(block), "订阅回调不再看前台/后台状态").toBe(true);
  });

  it("对比页置位过期不看前台状态（隐藏时也要记住结果已过期）", () => {
    const source = readScannedSource("src/components/DiffView.tsx");
    const blocks = subscriberCallbacks(source);
    expect(blocks.length, "对比页的订阅点数量变了").toBe(1);
    expect(/\bactive\b/.test(blocks[0]), "对比页一旦加了前台闸，回到面板时过期提示就会静默丢掉").toBe(false);
  });

  it("浏览页列表没取回来时不许清掉选中态", () => {
    const source = readScannedSource("src/components/ConfigBrowser.tsx");
    expect(/if \(!target \|\| !reloaded\) return;/.test(source), "重取失败也往下走，会把还在的配置误判成「被计划删了」").toBe(true);
  });
});

describe("总线保持纯净", () => {
  it("configChangeBus 不引 React、不发请求、不碰 store", () => {
    const source = readScannedSource(BUS);
    expect(/from "react"/.test(source), "纯发布订阅长进了 React 生命周期就没法在执行器单测里验证").toBe(false);
    expect(/from "\.\.\/api|from "\.\.\/store/.test(source), "总线自己取数 = 订阅方的时机策略被绕过").toBe(false);
  });
});

describe("写后失效的可见说明有文案", () => {
  for (const file of ["zh-CN.json", "en-US.json"]) {
    const flat = loadLocale(file);
    it(`${file} 的被删说明点名了是哪一条配置`, () => {
      const text = flat["config.removedByPlan"];
      expect(text, `${file} 缺少 config.removedByPlan`).toBeTruthy();
      expect(/\{dataId\}/.test(text), `${file} 的被删说明没有 dataId 插值`).toBe(true);
    });

    it(`${file} 的过期提示说清了结果已不可信`, () => {
      const text = flat["diff.resultStale"];
      expect(text, `${file} 缺少 diff.resultStale`).toBeTruthy();
      const saysStale = file.startsWith("zh") ? /过期|失效|不再最新/.test(text) : /stale|out of date|expired|no longer/i.test(text);
      expect(saysStale, `${file} 的 diff.resultStale 没说明这是过期结果：${text}`).toBe(true);
    });
  }
});

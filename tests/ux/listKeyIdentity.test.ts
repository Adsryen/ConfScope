/**
 * 列表 key 的身份不能随过滤漂移（轮6 R46）。
 *
 * 真 bug：LogViewer 先 `.filter(...)` 再 `.map((e, index) => <details key={index} open>)`。
 * 勾掉「显示内容」让事件整体上移，React 按位置复用 DOM，用户展开的那些 `<details open>`
 * 就串到了别的日志行上——看着像日志内容错乱。修法是把「显示与否」放进 map 内部决定，
 * key 始终按原始下标建立身份。这类错只在交互时才现形，所以静态钉住「filter 后接 map 还用下标当 key」。
 */
import { describe, expect, it } from "vitest";
import { lineAt, readScannedSource, sourceFiles } from "./scanUtils";

const INDEX_KEY = /key=\{(?:index|i|idx)\}/;

/** 从 `open`（指向 `(`）起做圆括号配平，返回闭合 `)` 的下标；带引号状态机，不会被 `")"` 骗过。 */
function closeParen(source: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

/** 一个 `.map(` 调用的区间与特征。 */
interface MapRegion {
  start: number;
  end: number;
  /** 回调是否真的取了第二个参数当下标（否则 key={index} 指的是外层别的变量）。 */
  takesIndex: boolean;
  /** 是否直接挂在 `.filter(...)` 之后（同一条链式调用）。 */
  chainedFromFilter: boolean;
}

/**
 * 找出「filter 直接接 map、map 回调取下标、返回值又用下标当 key」的位置。
 *
 * key 归属看**最内层**的 map：嵌套 map 时外层即使接在 filter 之后，只要 key 是内层列表用的就不算。
 */
function driftProneSites(file: string): string[] {
  const source = readScannedSource(file);
  const filterCloses = Array.from(source.matchAll(/\.filter\(/g), (m) => closeParen(source, (m.index ?? 0) + ".filter".length));
  const maps: MapRegion[] = Array.from(source.matchAll(/\.map\(/g)).flatMap((map) => {
    const start = map.index ?? 0;
    const open = start + ".map".length;
    const end = closeParen(source, open);
    if (end >= source.length) return [];
    // `.map(` 之后可能直接跟回调，也可能被格式化器换行再跟一层括号，所以先吃掉 `.map` 自己的左括号
    const callback = source.slice(open + 1, open + 140).replace(/^\s+/, "");
    return [
      {
        start: open,
        end,
        takesIndex: /^\(\s*[^()]*,\s*(?:index|i|idx)\s*\)\s*=>/.test(callback),
        // 只认「右括号就贴在这条 .map 前面」的 filter：close 比 map 还靠后时 slice 会是空串，必须排掉
        chainedFromFilter: filterCloses.some((close) => close < start && source.slice(close + 1, start).trim() === ""),
      },
    ];
  });
  const hits: string[] = [];
  for (const key of Array.from(source.matchAll(new RegExp(INDEX_KEY.source, "g")))) {
    const keyAt = key.index ?? 0;
    const owners = maps.filter((region) => keyAt > region.start && keyAt < region.end).sort((a, b) => a.end - a.start - (b.end - b.start));
    const owner = owners[0];
    if (!owner || !owner.takesIndex || !owner.chainedFromFilter) continue;
    hits.push(`${file}:${lineAt(file, keyAt)} → ${key[0]}`);
  }
  return hits;
}

const files = sourceFiles();

describe("列表 key 的身份稳定性", () => {
  it("扫描口径不是空转：全站确实有下标 key 在用", () => {
    const count = files.reduce((acc, file) => acc + Array.from(readScannedSource(file).matchAll(new RegExp(INDEX_KEY, "g"))).length, 0);
    expect(count).toBeGreaterThan(0);
  });

  it("不允许 filter 之后用下标当 key（过滤会让每一项的 key 换人）", () => {
    expect(files.flatMap(driftProneSites)).toEqual([]);
  });

  it("LogViewer 的事件行必须按原始下标建身份，显示与否在 map 内部决定", () => {
    const source = readScannedSource("src/components/LogViewer.tsx");
    expect(source, "事件列表又要变成先 filter 再 map 了（R46）").toContain("selected.events.map((e, index)");
    expect(source).toContain("if (!showContent && carriesValue) return null;");
    expect(source).toMatch(/<details\s+key=\{index\}/);
    expect(source, "detail 区不该再出现 selected.events.filter").not.toMatch(/selected\.events\s*\.filter\(/);
  });

  it("DiffPanel 的行 key 有自己的行号来源，且没踩 filter+下标 key 的坑", () => {
    expect(readScannedSource("src/components/DiffPanel.tsx")).toContain("key={rowIndex}");
    expect(driftProneSites("src/components/DiffPanel.tsx")).toEqual([]);
  });
});

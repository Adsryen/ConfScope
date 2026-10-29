/**
 * 弹层遮罩的关闭判定只认一个实现（轮14 波32 / R53）。
 *
 * 遮罩写成 `onClick={close}` 时，「在弹层里选中文本、拖到遮罩上松手」会把整个弹层关掉：
 * `click` 派发到 mousedown 与 mouseup 两个目标的**最近共同祖先**，也就是遮罩本身，
 * 弹层本体上的 `stopPropagation` 完全没被调用。批量替换表单、连接配置、删除确认
 * 都是这么丢数据的。波32 把 9 个遮罩站点收进 `src/lib/useOverlayDismiss.ts`，这里钉住不再长出第二份。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, readScannedSource, sourceFiles } from "./scanUtils";

const HOOK = "src/lib/useOverlayDismiss.ts";
const GESTURES = "src/test/react.ts";
/** 组件与 hook 的行为用例：sourceFiles() 把测试文件排掉了，这里自己走一遍。 */
function behaviorTests(dir = "src"): string[] {
  const acc: string[] = [];
  for (const entry of readdirSync(join(PROJECT_ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      acc.push(...behaviorTests(rel));
      continue;
    }
    if (/\.test\.tsx?$/.test(entry.name)) acc.push(rel);
  }
  return acc.sort();
}

/** 遮罩类名：带这个 token 的开标签就是本守卫管的站点。 */
const OVERLAY_TOKEN = "modal-overlay";

/** 站点名单（文件 → 遮罩数量）。加/减遮罩都要连同理由一起改这张表。 */
const SITES: Record<string, number> = {
  "src/components/About.tsx": 1,
  "src/components/AlertModal.tsx": 1,
  "src/components/ConfigBrowser.tsx": 2,
  "src/components/ConfigEditor.tsx": 1,
  "src/components/ConfirmModal.tsx": 1,
  "src/components/ConnectionManager.tsx": 1,
  "src/components/DeleteConfirm.tsx": 1,
  "src/components/EditorDialog.tsx": 1,
  "src/components/ErrorDialog.tsx": 1,
};
const EXPECTED_TOTAL = 10; // r136 起含长文本编辑弹层外壳 EditorDialog

/** 从 `<div` 的尖括号起取到开标签结束（带括号深度与引号状态，别被 JSX 表达式里的 `>` 截断）。 */
function openingTagAt(source: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
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
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (ch === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function classTokens(tag: string): string[] {
  const literal = tag.match(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/);
  const raw = literal ? `${literal[1] ?? ""} ${literal[2] ?? ""} ${literal[3] ?? ""}` : "";
  return raw.split(/[\s${}]+/).filter(Boolean);
}

interface OverlaySite {
  file: string;
  line: number;
  tag: string;
}

function overlaySites(): OverlaySite[] {
  const found: OverlaySite[] = [];
  for (const file of sourceFiles()) {
    const source = readScannedSource(file);
    for (const match of source.matchAll(/<div\b/g)) {
      const start = match.index ?? 0;
      const tag = openingTagAt(source, start);
      if (!tag || !classTokens(tag).includes(OVERLAY_TOKEN)) continue;
      found.push({ file, line: source.slice(0, start).split("\n").length, tag });
    }
  }
  return found;
}

/** 把 hook 里三个处理器的函数体切出来，逐条判形态。 */
function handlerBodies(source: string): Record<string, string> {
  const names = ["onMouseDown", "onMouseUp", "onClick"];
  const out: Record<string, string> = {};
  for (const name of names) {
    const marker = `const ${name} = (`;
    const start = source.indexOf(marker);
    if (start === -1) {
      out[name] = "";
      continue;
    }
    const rest = source.slice(start + marker.length);
    const cuts = names
      .filter((other) => other !== name)
      .map((other) => rest.indexOf(`const ${other} = (`))
      .filter((index) => index > -1);
    out[name] = cuts.length ? rest.slice(0, Math.min(...cuts)) : rest;
  }
  return out;
}

describe("遮罩关闭判定单一出口（波32 R53）", () => {
  it("遮罩站点名单与数量钉死，且每处都展开 useOverlayDismiss 的结果", () => {
    const sites = overlaySites();
    expect(sites).toHaveLength(EXPECTED_TOTAL);

    const counts: Record<string, number> = {};
    for (const site of sites) counts[site.file] = (counts[site.file] ?? 0) + 1;
    expect(counts).toEqual(SITES);

    for (const site of sites) {
      const spreads = Array.from(site.tag.matchAll(/\{\.\.\.([A-Za-z0-9_]+)\}/g), (m) => m[1]);
      expect(spreads.length, `${site.file}:${site.line} 的遮罩没有展开 hook 结果`).toBeGreaterThan(0);
      const declared = readScannedSource(site.file);
      const wired = spreads.some((id) => new RegExp(`const ${id}\\w*\\s*=\\s*useOverlayDismiss\\(`).test(declared));
      expect(wired, `${site.file}:${site.line} 展开的不是 useOverlayDismiss 的返回值`).toBe(true);
      // 手搓的 onClick 必须消失，否则又变成「点一下就关」的老写法
      expect(/\bonClick[=:{]/.test(site.tag), `${site.file}:${site.line} 遮罩上还挂着裸 onClick`).toBe(false);
    }
  });

  it("hook 必须同时判「按下点」与「点击落点」，且 onClick 真的读到按下记录", () => {
    const source = readScannedSource(HOOK);
    expect(source).toContain('from "react"');
    expect(source).toMatch(/import \{ useRef \} from "react"/);
    const bodies = handlerBodies(source);
    expect(bodies.onMouseDown).toMatch(/\.current = event\.target === event\.currentTarget/);
    expect(bodies.onClick).toMatch(/event\.target !== event\.currentTarget/);
    expect(bodies.onClick).toMatch(/[A-Za-z0-9_]*[Pp]ressed[A-Za-z0-9_]*\.current/);
    expect(bodies.onMouseUp).toMatch(/event\.target !== event\.currentTarget/);
    // 关闭动作必须在两条判定之后，不许无条件调用
    const dismissIndex = bodies.onClick.lastIndexOf("dismiss()");
    const gateIndex = bodies.onClick.indexOf("return");
    expect(dismissIndex).toBeGreaterThan(gateIndex);
  });

  it("接线文件都 import 了 hook，且没留下第二处手搓遮罩判定", () => {
    for (const file of Object.keys(SITES)) {
      const source = readScannedSource(file);
      expect(source, `${file} 没有引入 useOverlayDismiss`).toContain('from "../lib/useOverlayDismiss"');
      expect(source.match(/useOverlayDismiss\(/g)?.length ?? 0).toBeGreaterThanOrEqual(SITES[file]);
    }
  });

  it("测试助手钉住完整手势：clickOverlay 必须按下—释放—点击三步，负向轨迹助手存在", () => {
    const gestures = readScannedSource(GESTURES);
    const body = gestures.slice(gestures.indexOf("export function clickOverlay"));
    expect(body.slice(0, 400)).toMatch(
      /fireEvent\.mouseDown\(overlay\)[\s\S]*fireEvent\.mouseUp\(overlay\)[\s\S]*fireEvent\.click\(overlay\)/
    );
    expect(gestures).toMatch(/export function dragFromPanelOntoOverlay/);
    const drag = gestures.slice(gestures.indexOf("export function dragFromPanelOntoOverlay"));
    expect(drag.slice(0, 400)).toMatch(
      /fireEvent\.mouseDown\(panel\)[\s\S]*fireEvent\.mouseUp\(overlay\)[\s\S]*fireEvent\.click\(overlay\)/
    );
  });

  it("防死钩子：既有用例仍在真点遮罩（≥6 处）并盯住误关轨迹", () => {
    let clickOverlayUses = 0;
    let dragUses = 0;
    for (const file of behaviorTests()) {
      const text = readScannedSource(file);
      clickOverlayUses += (text.match(/clickOverlay\(/g) ?? []).length;
      dragUses += (text.match(/dragFromPanelOntoOverlay\(/g) ?? []).length;
    }
    expect(clickOverlayUses).toBeGreaterThanOrEqual(8);
    expect(dragUses).toBeGreaterThanOrEqual(3);
  });
});

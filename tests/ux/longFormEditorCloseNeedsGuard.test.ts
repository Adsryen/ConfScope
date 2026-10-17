/**
 * 守卫：承载可编辑长文本（CodeEditor + onChange）的界面，「离开/关闭」出口不许直连父层回调。
 *
 * 为什么盯长文本：单行输入框点错遮罩，重写十秒；手写几十行 YAML 点错一下，
 * 没有草稿箱、没有撤销、也没有历史，是永久丢失。轮5 的 R36 就出在这里——
 * 新建配置的四条出口（Esc / 点遮罩 / × / 底部「取消」）当时全都直连 onClose，
 * 而隔壁「编辑已有配置」早在波2 就装了 guardNav 确认：同一件事，一个问一个不问。
 *
 * 口径：
 * 1. 宿主文件 = 本文件里出现带 onChange 的 `<CodeEditor …>`（只读展示不算）；
 * 2. 出口 = React 事件属性（onClick/onMouseDown/onMouseUp/onKeyDown/onKeyUp）与 useEscape 第二参；
 *    其值是 `onXxx` 形态的 prop 标识符（或 `() => onXxx()` 空壳）**且名字带关闭/离开语义**才算违规——
 *    `attemptClose`、`cancelEditing`、`onConfirm={onClose}` 这些形态不误报；
 * 3. 已知未设守门的出口用 KNOWN_UNGUARDED 逐条钉住，只减不增：修掉一条就必须同步删条目，
 *    新增一条直接红（这是按**名字**判的，改名叫 onHide 会漏，所以行为测试仍是主力）。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

/** React 原生事件属性（组件自定义 prop 不在内，那是 onConfirm={onClose} 的合法写法）。 */
const EVENT_ATTRS = "onClick|onMouseDown|onMouseUp|onKeyDown|onKeyUp";
/** 关闭/离开语义：这些 prop 被直连就意味着「一步到位，不问第二句」；onSelectAll/onDryRun 不算出口。 */
const CLOSE_SEMANTICS = /(?:Close|Dismiss|Cancel|Abort|Exit|Leave|Back|Discard)/;
const bareHandler = new RegExp(`\\b(?:${EVENT_ATTRS})=\\{\\s*(on[A-Z][\\w$]*)\\s*\\}`, "g");
const noopArrow = new RegExp(`\\b(?:${EVENT_ATTRS})=\\{\\s*\\(\\s*\\)\\s*=>\\s*(on[A-Z][\\w$]*)\\(\\s*\\)\\s*\\}`, "g");
const escapeDirect = /\buseEscape\s*\([^;]*?,\s*(on[A-Z][\w$]*)\s*,\s*EscapePriority/g;

/**
 * 已知未守门的出口（波13 交付时实测就这一条）：见轮7 research R58。
 * 清单按「文件 + prop 名」钉，不带行号——否则上方插一行就误报。
 */
const KNOWN_UNGUARDED = ["src/components/ApplyPlanView.tsx onBack"];

interface Site {
  file: string;
  line: number;
  handler: string;
  kind: string;
}

function asLabel(site: Site): string {
  return `${site.file} ${site.handler}`;
}

/** CodeEditor 的属性会换行写：从标签起点取一段窗口，看到 onChange 才算受控可编辑。 */
function isEditableLongFormHost(source: string): boolean {
  return Array.from(source.matchAll(/<CodeEditor\b/g), (m) => m.index ?? 0).some((start) => {
    const tail = source.slice(start, start + 800);
    const selfClose = tail.search(/\/>|\>/);
    const scope = selfClose > 0 ? tail.slice(0, selfClose) : tail;
    return /\bonChange=/.test(scope);
  });
}

describe("长文本编辑界面的关闭出口必须经过脏草稿守门", () => {
  const hosts: string[] = [];
  const violations: Site[] = [];
  let exitsScanned = 0;

  for (const rel of sourceFiles()) {
    const source = readScannedSource(rel);
    if (!isEditableLongFormHost(source)) continue;
    hosts.push(rel);

    for (const [re, kind] of [
      [bareHandler, "事件属性直传 prop"],
      [noopArrow, "事件属性只是 prop() 空壳"],
      [escapeDirect, "useEscape 直传 prop"],
    ] as const) {
      for (const m of source.matchAll(re)) {
        if (!CLOSE_SEMANTICS.test(m[1])) continue;
        violations.push({ file: rel, line: source.slice(0, m.index).split("\n").length, handler: m[1], kind });
      }
    }
    // 命中量：宿主文件里一共审了多少个出口（含已守门的），防止口径漂成空扫。
    exitsScanned += Array.from(source.matchAll(new RegExp(`\\b(?:${EVENT_ATTRS})=\\{`, "g"))).length;
    exitsScanned += Array.from(source.matchAll(/\buseEscape\s*\(/g)).length;
  }

  it("至少扫到 3 个可编辑长文本宿主（口径飘了先在这里红）", () => {
    expect(hosts).toEqual(
      expect.arrayContaining(["src/components/ConfigEditor.tsx", "src/components/ConfigBrowser.tsx", "src/components/ApplyPlanView.tsx"])
    );
    expect(hosts.length).toBeGreaterThanOrEqual(3);
  });

  it("宿主出口要有实际命中量（防空转）", () => {
    expect(exitsScanned).toBeGreaterThanOrEqual(20);
  });

  it("未守门的关闭出口必须与已知清单逐条相等（只减不增）", () => {
    expect(violations.map(asLabel).sort(), violations.map((v) => `${asLabel(v)} — ${v.kind}`).join("\n")).toEqual(
      [...KNOWN_UNGUARDED].sort()
    );
  });
});

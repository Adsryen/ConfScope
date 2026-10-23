/**
 * 「历史变更」顶部的来源分段必须说实话（轮67 R57-WP15）。
 *
 * 这层分段决定屏幕上出现哪一列历史：「配置中心」是服务端记下的那次发布，
 * 「本机」是这台机器见过哪一版。两者字段不同、覆盖范围不同，一旦按下态与在屏内容脱钩，
 * 用户会以为自己看的是服务端历史，其实读的是本机缓存——而且整条链路一次错都不报。
 *
 * 轮49 已经为同类控件付过一次学费（historyViewModeToggleTellsTruth：一颗按钮同时改文案、
 * 改 active、改 aria-pressed，三者指向另一个视图）。这里照同一套指针再钉一遍，只把布尔
 * 换成档位字符串：按钮名 ↔ aria-pressed 比较的档位 ↔ class 里 " active" 落在哪个档位
 * ↔ 点下去写入的档位 ↔ 该档位下真正在屏的组件，五者必须同向。
 *
 * 另外钉三条只有「两个源并列」才会出现的问题：
 *   - 分段只在两个源都可达时出现（只有一个选项的分段是噪音，还会让人以为另一档被自己关了）；
 *   - 服务端那一档由 supportsConfigHistory 收口，不可达时必须退回本机，不能让空面板占屏；
 *   - 两棵下游面板都要接到 active / searchTerm，否则后台 tab 的正文搜索会悄悄停在这半屏。
 *
 * 注释一律剥掉再算（与 scanUtils 同一口径），否则注释里抄着的类名与档位名会被当成实现。
 */
import { describe, expect, it } from "vitest";
import { loadLocale, readScannedSource } from "./scanUtils";

const PANEL = "src/components/ConfigHistoryPanel.tsx";
const STATE_FLAG = "source";
const SETTER = "setSource";
const GATE = "bothCapable";
const SERVER_FLAG = "serverCapable";
const LOCAL_FLAG = "localCapable";

/** 真相表：按钮名 ↔ 比较/写入的档位 ↔ 该档位下在屏的组件。 */
const EXPECTED: Array<{ labelKey: string; stateValue: string; view: string }> = [
  { labelKey: "history.sourceServer", stateValue: "server", view: "HistoryView" },
  { labelKey: "history.sourceLocal", stateValue: "local", view: "LocalRevisionPanel" },
];

/** 两颗面板都必须从壳里接到这些 prop（少一个就是一半功能在某一档下静默失效）。 */
const REQUIRED_FORWARD = [
  "conn={conn}",
  "tenant={tenant}",
  "dataId={dataId}",
  "group={group}",
  "currentContent={currentContent}",
  "format={format}",
  "active={active}",
  "searchTerm={searchTerm}",
  "onStartApply={onStartApply}",
];

/** 从标签名之后扫到属性区结束（深度 0 的 `>`），箭头函数里的 `>` 不能截断。 */
function attrRegion(source: string, afterName: number): { attrs: string; bodyStart: number } | null {
  let i = afterName;
  let depth = 0;
  const buf: string[] = [];
  while (i < source.length) {
    const ch = source[i];
    if (depth === 0 && ch === ">") return { attrs: buf.join("").trim(), bodyStart: i + 1 };
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    buf.push(ch);
    i += 1;
  }
  return null;
}

/** 取 name={...} 的表达式体（按花括号深度配对）。 */
function exprOf(attrs: string, name: string): string {
  const key = `${name}={`;
  const start = attrs.indexOf(key);
  if (start < 0) return "";
  let i = start + key.length;
  let depth = 1;
  const buf: string[] = [];
  while (i < attrs.length && depth > 0) {
    const ch = attrs[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
    buf.push(ch);
    i += 1;
  }
  return buf.join("").trim();
}

/** 只认「恒定命名的按钮」：整个按钮体必须恰好是 {t("history.xxx")}，带三元就判不出来说的是谁。 */
function labelKeyOf(body: string): string {
  const found = /^\{\s*t\(\s*"([^"]+)"\s*\)\s*\}$/.exec(body.trim());
  return found ? found[1] : "";
}

/** aria-pressed={source === "x"} ⇒ 返回 x；写成 !、写成别的表达式一律判 "other"。 */
function pressedValue(expr: string): string {
  const found = new RegExp(`^${STATE_FLAG}\\s*===\\s*"([^"]+)"$`).exec(expr.trim());
  return found ? found[1] : expr ? `other:${expr}` : "missing";
}

/** class 里 " active" 跟着哪个档位：档位判断反了（active 落在 else）判 "inverted:x"。 */
function activeValue(expr: string): string {
  const found = new RegExp(
    `\\$\\{\\s*${STATE_FLAG}\\s*===\\s*"([^"]+)"\\s*\\?\\s*"([^"]*)"\\s*:\\s*"([^"]*)"\\s*\\}`
  ).exec(expr);
  if (!found) return /active/.test(expr) ? "static" : "none";
  const onTrue = found[2].includes("active");
  const onFalse = found[3].includes("active");
  if (onTrue && onFalse) return "always";
  if (onTrue) return found[1];
  if (onFalse) return `inverted:${found[1]}`;
  return "none";
}

/** 点下去写入哪个档位：只许显式常量 setSource("x")，翻转或写死一律判 non-constant。 */
function setterValue(expr: string): string {
  const found = new RegExp(`\\b${SETTER}\\(\\s*"([^"]+)"\\s*\\)`).exec(expr);
  if (found) return found[1];
  return expr ? "non-constant" : "missing";
}

/** 那颗 .view-mode 容器的属性区与内部片段（按 <div>/</div> 配对，不靠第一个 </div> 侥幸）。 */
function groupSpan(source: string): { attrs: string; body: string; at: number } | null {
  const at = source.indexOf('className="view-mode"');
  if (at < 0) return null;
  const openTag = source.lastIndexOf("<div", at);
  if (openTag < 0) return null;
  const region = attrRegion(source, openTag + 4);
  if (!region) return null;
  let depth = 0;
  let i = region.bodyStart;
  while (i < source.length) {
    if (source.startsWith("</div>", i)) {
      if (depth === 0) break;
      depth -= 1;
      i += 6;
      continue;
    }
    if (source.startsWith("<div", i)) {
      depth += 1;
      i += 4;
      continue;
    }
    i += 1;
  }
  return { attrs: region.attrs, body: source.slice(region.bodyStart, i), at };
}

/** 在屏分支：`showLocal ? (<A>) : (<B>)`，返回两分支各自渲染的面板名。 */
function renderBranches(source: string): { localShown: string; serverShown: string } | null {
  const found = new RegExp(`\\bshowLocal\\s*\\?\\s*\\(`).exec(source);
  if (!found) return null;
  const after = source.slice(found.index + found[0].length);
  const split = after.indexOf(") : (");
  if (split < 0) return null;
  return {
    localShown: /<([A-Z][A-Za-z0-9_]*)/.exec(after.slice(0, split))?.[1] ?? "",
    serverShown: /<([A-Z][A-Za-z0-9_]*)/.exec(after.slice(split + " ) : (".length - 1))?.[1] ?? "",
  };
}

/** 取某个 JSX 组件标签的属性区全文，用于核对透传清单。 */
function jsxAttrs(source: string, tagName: string): string {
  const at = source.indexOf(`<${tagName}`);
  if (at < 0) return "";
  return attrRegion(source, at + tagName.length + 1)?.attrs ?? "";
}

function segmentViolations(source: string): string[] {
  const violations: string[] = [];
  const groupCount = source.split('className="view-mode"').length - 1;
  if (groupCount !== 1) violations.push(`.view-mode 容器应当只有一颗，实际 ${groupCount}`);
  const group = groupSpan(source);
  if (!group) {
    violations.push("找不到来源分段的容器");
    return violations;
  }
  if (!/(^|\s)role="group"/.test(group.attrs)) violations.push('分段缺 role="group"，两颗按钮读起来不成一个控件');
  const groupLabel = exprOf(group.attrs, "aria-label");
  if (groupLabel !== 't("history.sourceGroup")') {
    violations.push(`分段组名必须是恒定的 t("history.sourceGroup")，实际「${groupLabel || "无"}」`);
  }

  // 分段只在两个源都可达时出现，且必须出现在容器之前
  const gateAt = source.indexOf(`{${GATE} && (`);
  if (gateAt < 0) violations.push(`分段必须整块挂在 {${GATE} && (} 之后，不能无条件渲染`);
  else if (gateAt > group.at) violations.push(`${GATE} 闸门必须在分段容器之前，不然只有一个源时也会长出分段`);

  const buttons = [...group.body.matchAll(/<button\b/g)];
  if (buttons.length !== EXPECTED.length) {
    violations.push(`分段应当有 ${EXPECTED.length} 颗按钮，实际 ${buttons.length}`);
    return violations;
  }
  const branches = renderBranches(source);
  if (!branches) violations.push("找不到 showLocal 的在屏分支，无法核对「按钮档位 ↔ 屏上面板」");

  for (const exp of EXPECTED) {
    const facts = buttons
      .map((m) => {
        const region = attrRegion(group.body, m.index + m[0].length);
        if (!region) return null;
        const end = group.body.indexOf("</button>", region.bodyStart);
        return {
          labelKey: labelKeyOf(end < 0 ? "" : group.body.slice(region.bodyStart, end)),
          pressed: pressedValue(exprOf(region.attrs, "aria-pressed")),
          active: activeValue(exprOf(region.attrs, "className")),
          sets: setterValue(exprOf(region.attrs, "onClick")),
          isButtonType: /(^|\s)type="button"/.test(region.attrs),
        };
      })
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .filter((b) => b.labelKey === exp.labelKey);
    if (facts.length !== 1) {
      violations.push(`${exp.labelKey} 应当恰好出现一次（当前 ${facts.length} 次；按钮名不许多态也不许缺席）`);
      continue;
    }
    const btn = facts[0];
    const where = `${exp.labelKey}`;
    if (!btn.isButtonType) violations.push(`${where} 缺 type="button"，在表单里点它会顺手提交`);
    if (btn.pressed !== exp.stateValue) {
      violations.push(`${where} 的 aria-pressed 比较的是 ${btn.pressed}，应指向 ${exp.stateValue}`);
    }
    if (btn.active !== exp.stateValue) {
      violations.push(`${where} 的 " active" 落在 ${btn.active}，与按下态不同向（视觉与读屏各说一套）`);
    }
    if (btn.sets !== exp.stateValue) {
      violations.push(`${where} 点下去写入 ${btn.sets}，应写入 ${exp.stateValue}`);
    }
    if (branches) {
      const shown = exp.stateValue === "local" ? branches.localShown : branches.serverShown;
      if (shown !== exp.view) {
        violations.push(`${where} 说自己是 ${exp.view}，但 ${exp.stateValue} 档在屏的是 ${shown || "?"}`);
      }
    }
  }
  const others = buttons.filter((m) => {
    const region = attrRegion(group.body, m.index + m[0].length);
    if (!region) return false;
    const end = group.body.indexOf("</button>", region.bodyStart);
    const key = labelKeyOf(end < 0 ? "" : group.body.slice(region.bodyStart, end));
    return !EXPECTED.some((exp) => exp.labelKey === key);
  });
  for (const b of others) violations.push("分段出现未知按钮名（非恒定文案或新档位）");

  // 能力收口：服务端那一档必须由能力表判定，不可达时退回本机
  if (!new RegExp(`const ${SERVER_FLAG} = supportsConfigHistory\\(conn\\);`).test(source)) {
    violations.push("服务端那一档必须由 supportsConfigHistory(conn) 收口，不许自己猜 provider");
  }
  if (!new RegExp(`const ${LOCAL_FLAG} = localRevisionStoreAvailable\\(\\);`).test(source)) {
    violations.push("本机那一档必须由 localRevisionStoreAvailable() 收口，不许按「有没有记录」猜");
  }
  if (!new RegExp(`const ${GATE} = ${SERVER_FLAG} && ${LOCAL_FLAG};`).test(source)) {
    violations.push(`${GATE} 必须是两个源的与，不能只看其中一个`);
  }
  if (!new RegExp(`useState<HistorySource>\\(${SERVER_FLAG} \\? "server" : "local"\\)`).test(source)) {
    violations.push("默认档位必须是「服务端可达就 server，否则 local」，硬编码任一侧都会让面板空着");
  }
  if (!source.includes(`if (!${SERVER_FLAG}) ${SETTER}("local");`)) {
    violations.push("连接被改成服务端不支持历史时必须退回本机那一档");
  }
  if (!new RegExp(`const showLocal = !${SERVER_FLAG} \\|\\| ${STATE_FLAG} === "local";`).test(source)) {
    violations.push("在屏内容必须同时受服务端可达性与所选档位约束");
  }

  for (const view of ["HistoryView", "LocalRevisionPanel"]) {
    const attrs = jsxAttrs(source, view);
    if (!attrs) {
      violations.push(`${view} 没在分段宿主里渲染`);
      continue;
    }
    const missing = REQUIRED_FORWARD.filter((prop) => !attrs.includes(prop));
    if (missing.length) violations.push(`${view} 少透传：${missing.join(", ")}`);
  }
  return violations;
}

describe("历史来源分段说实话（轮67 R57-WP15 守卫）", () => {
  const src = readScannedSource(PANEL);

  it("按钮名 / 按下态 / 视觉态 / 写入档位 / 在屏面板五者同向", () => {
    const found = segmentViolations(src);
    expect(found, found.length ? "来源分段在说谎：\n" + found.join("\n") : "").toEqual([]);
  });

  it("解析器自证：真的取到两颗按钮，且每根指针都有取值", () => {
    const group = groupSpan(src);
    expect(group).not.toBeNull();
    const bodies = [...group!.body.matchAll(/<button\b/g)].map((m) => {
      const region = attrRegion(group!.body, m.index + m[0].length)!;
      const end = group!.body.indexOf("</button>", region.bodyStart);
      return {
        labelKey: labelKeyOf(group!.body.slice(region.bodyStart, end)),
        pressed: pressedValue(exprOf(region.attrs, "aria-pressed")),
        active: activeValue(exprOf(region.attrs, "className")),
        sets: setterValue(exprOf(region.attrs, "onClick")),
      };
    });
    expect(bodies).toHaveLength(2);
    for (const btn of bodies) {
      expect(btn.labelKey).toMatch(/^history\.source/);
      expect(EXPECTED.map((e) => e.stateValue)).toContain(btn.pressed);
      expect(EXPECTED.map((e) => e.stateValue)).toContain(btn.active);
      expect(EXPECTED.map((e) => e.stateValue)).toContain(btn.sets);
    }
    expect(renderBranches(src)).toEqual({ localShown: "LocalRevisionPanel", serverShown: "HistoryView" });
  });

  it("两棵面板各接一份透传，且只透传 prop 不就地算词", () => {
    expect(jsxAttrs(src, "HistoryView")).not.toBe("");
    expect(jsxAttrs(src, "LocalRevisionPanel")).not.toBe("");
    expect(src).not.toMatch(/isContentSearchActive|searchMode/);
  });

  it("中英两份都有组名与两个档位名，互不相同，也不与「正文视图」那组的组名撞车", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const flat = loadLocale(file);
      const values = ["history.sourceGroup", "history.sourceServer", "history.sourceLocal"].map((key) => flat[key]);
      for (const [index, value] of values.entries()) {
        expect(value, `${file} 缺第 ${index} 颗键`).toBeTruthy();
      }
      const [group, server, local] = values as [string, string, string];
      expect(new Set([group, server, local]).size, `${file} 三个名称彼此重复`).toBe(3);
      // 两段分段同屏出现（来源在上、正文视图在下），组名撞车时读屏分不清在选哪件事
      expect(group, `${file} 的来源组名与正文视图组名撞车`).not.toBe(flat["history.viewMode"]);
      for (const label of [group, server, local]) {
        expect(label, `${file} 的「${label}」把来源写成了动作`).not.toMatch(/切换|查看|Switch|Toggle/i);
      }
    }
  });

  it("自检：逐条变异真的被挡住（不是正则空转）", () => {
    const mutations: Array<[string, string, string]> = [
      [
        "aria-pressed 指错档",
        src.replace('aria-pressed={source === "server"}', 'aria-pressed={source === "local"}'),
        "aria-pressed={source === \"local\"}",
      ],
      ["丢掉按下态", src.replace('${source === "local" ? " active" : ""}', ""), "active"],
      [
        "点下去写入另一个档",
        src.replace('onClick={() => setSource("server")}', 'onClick={() => setSource("local")}'),
        "setSource(\"local\")",
      ],
      [
        "文案回到随状态变化",
        src.replace('{t("history.sourceServer")}', '{source === "server" ? t("history.sourceServer") : t("history.sourceLocal")}'),
        "sourceServer",
      ],
      ["只有一个源也硬渲染分段", src.replace("{bothCapable && (", "{true && ("), "bothCapable"],
      [
        "在屏分支的判断反了",
        src.replace('const showLocal = !serverCapable || source === "local";', 'const showLocal = !serverCapable || source === "server";'),
        "showLocal",
      ],
      [
        "默认档硬编码成 server",
        src.replace('useState<HistorySource>(serverCapable ? "server" : "local")', 'useState<HistorySource>("server")'),
        "useState<HistorySource>",
      ],
      ["服务端不可达时不退回本机", src.replace('if (!serverCapable) setSource("local");', ""), "serverCapable"],
      ["少透传 active", src.replace("          active={active}\n          dataId={dataId}\n          group={group}\n          currentContent={currentContent}\n          format={format}\n          searchTerm={searchTerm}\n          onStartApply={onStartApply}\n        />\n      ) : (", "        />\n      ) : ("), "HistoryView"],
    ];
    for (const [name, mutated, needle] of mutations) {
      expect(mutated, `「${name}」这条变异没落进被测文本（needle=${needle}）`).not.toBe(src);
      expect(segmentViolations(mutated), `「${name}」没有被挡住`).not.toEqual([]);
    }
  });
});

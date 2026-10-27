/**
 * 守卫：每个输入控件都要有「不会消失的名字」（轮10 R40）。
 *
 * 现象：全站 111 个 input/textarea/select 里，5 个完全没名字、10 个只写了 placeholder、
 * 1 个 checkbox 只写了 title。读屏走到这些框只能念「编辑框」，用户听不出这是搜配置的、
 * 筛连接的，还是确认删除的。placeholder 在输入第一个字符时就消失，title 只在鼠标悬停时
 * 出现，两者都撑不起「名字」这个职责——所以本守卫明确不认它们。
 *
 * 口径（命中任一即合规）：
 * 1. 自己写 `aria-label` / `aria-labelledby`；
 * 2. 同文件里 `id=` 与某个 `<label htmlFor=>` 配成对；
 * 3. 被 `<label>` 包住（HTML 隐式关联），且同时满足两件事（见下）：
 *    a. 自己是这只 label 里**第一只**需要名字的控件；
 *    b. 这只 label 里没有动作类交互内容（按钮 / 链接 / 密码显隐框）；
 * 4. 经共享组件时（Combobox / NumberField / CodeEditor）：组件本体必须有 `aria-label` 兜底，
 *    调用点要么在干净的 `<label>` 内，要么显式传 `ariaLabel=`。
 *
 * 第 3 条为什么要带后半句（轮67 R67-WP9）——过去「在 label 内」是无条件放行，两个真实缺陷因此长期存在：
 *
 * **a. 隐式关联只认第一只控件。** HTML 规范里 `<label>` 不带 htmlFor 时，只和它子树里
 * 第一个 labelable 后代配对。连接表单「项目」那一栏在同一个 label 里并排坐着下拉框和
 * 新建时的文本框：读屏走到文本框只念「编辑框，空白」，名字全给了上面那只下拉框。
 *
 * **b. 动作类内容会把文字并进名字。** accname 的「从内容取名」会吃掉 label 子树里的可见文字，
 * 只要 label 里还坐着一颗按钮，框的名字就变成「默认命名空间 ID（留空=public） 加载命名空间」
 * 这种半句话＋一个动作——读屏用户听完标题还得再听一遍按钮名，测试里
 * `getByLabel(标题, {exact:true})` 也取不到。
 *
 * 修法同形（与 PasswordField R67-WP6 一致）：标题元素给 id，控件显式 `aria-labelledby` 指过去。
 * 两类节点要分开判：文本类控件之间**不互相贡献文字**（input 的 value 不参与取名），它们的问题是
 * 「抢不到关联」；按钮 / 链接 / 显隐框才是「污染名字」。扫描器据此分成 A/B 两类口径。
 *
 * 范围：`type="hidden|submit|button|image|reset"` 不查（按钮的 `value` 自带名字），
 * `checkbox` / `radio` 一律要查——它们是本轮唯一「只剩 title」的漏网类型。
 *
 * 防永真：命中量下限（控件总数、checkbox 数、placeholder 数、各合规来源各自的下限）。
 * 扫描口径漂掉时先在数量上红，而不是让合规判定空转把违规吞掉。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, sourceFiles } from "./scanUtils";

/** 需要名字的裸标签 */
const CONTROLS = new Set(["input", "textarea", "select"]);
/** 内部自带 input/textarea 的共享组件 */
const SHARED_COMPONENTS = new Set(["Combobox", "NumberField", "CodeEditor"]);
/** 不指望外部给名字的 input 类型 */
const EXEMPT_TYPES = new Set(["hidden", "submit", "button", "image", "reset"]);
/** 兜底写法：先取调用方给的名字，再退到 placeholder */
const FALLBACK_RE = /aria-label=\{ariaLabel \?\? placeholder\}/;
/** 兜底写法必须存在的文件 */
const FALLBACK_FILES = ["src/components/Combobox.tsx", "src/components/NumberField.tsx", "src/components/CodeEditor.tsx"];

/** 取开标签的属性文本：花括号/引号里的 `>` 不算结束（`onChange={(e) => x}` 里全是 `>`）。 */
function tagHead(source: string, start: number): { attrs: string; selfClosing: boolean } {
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
    else if (ch === ">" && depth === 0) {
      const body = source.slice(start, i);
      return { attrs: body.replace(/\/$/, ""), selfClosing: /\/$/.test(body) };
    }
  }
  return { attrs: source.slice(start), selfClosing: false };
}

/** 属性字面量值：`x="a"` / `x='a'` / `x={a}` 三种写法统一取出来。 */
function attrValue(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*([^}]+?)\\s*\\})`).exec(attrs);
  if (!m) return undefined;
  return (m[1] ?? m[2] ?? m[3] ?? "").trim();
}

/** 全文某属性的所有字面量值：用来把 `<label htmlFor=>` 收成配对集合。 */
function allAttrValues(source: string, name: string): Set<string> {
  const acc = new Set<string>();
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*([^}]+?)\\s*\\})`, "g");
  for (const m of source.matchAll(re)) acc.add((m[1] ?? m[2] ?? m[3] ?? "").trim());
  return acc;
}

/**
 * B 类：需要名字的控件（labelable）。同一只 label 里只有第一个能拿到隐式关联的名字。
 * 复选框/单选框也算——它们是「label 包控件 + 文字」的正规写法，名字来源正是 label 文字；
 * 但两只并排时第二只同样拿不到名字，所以按位置判定，不按类型豁免。
 */
function isLabelableInLabel(name: string): boolean {
  return CONTROLS.has(name) || SHARED_COMPONENTS.has(name);
}

/**
 * A 类：动作类交互内容。它的可见文字会被 accname 并进同 label 控件的名字，
 * 除裸 button / a[href] / 按钮型 input，本仓库还有一眼就能看出是按钮的组件（`*Button`、
 * `*Toggle`），以及自带显隐开关的 PasswordField。
 * aria-hidden 的内容不进 accname（连接表单的 FieldLabel 帮助角标就是 aria-hidden 的 span），
 * 所以带 `aria-hidden="true"` 的节点不算污染。
 */
function isActionInLabel(name: string, attrs: string): boolean {
  if (/^["']true["']$/.test(attrValue(attrs, "aria-hidden") ?? "")) return false;
  if (name === "button") return true;
  if (name === "a" && attrValue(attrs, "href") !== undefined) return true;
  if (name === "PasswordField") return true;
  if (/(?:Button|Toggle)$/.test(name)) return true;
  if (name === "input") {
    const type = attrValue(attrs, "type") ?? "text";
    return ["button", "submit", "reset", "image"].includes(type);
  }
  return false;
}

interface Site {
  file: string;
  line: number;
  name: string;
  type: string;
  attrs: string;
  /** true = 裸标签，false = 共享组件调用点 */
  isControl: boolean;
  viaAria: boolean;
  viaAssociate: boolean;
  viaLabel: boolean;
  viaProp: boolean;
  /** 所在 <label> 里除自己之外还有动作类内容 ⇒ label 文字不再是干净的名字来源 */
  labelPolluted: boolean;
  /** 所在 <label> 里自己前面还有别的控件 ⇒ 隐式关联归它，label 文字轮不到自己 */
  labelStolen: boolean;
  /** 污染/竞争来源，报错时摆出来 */
  labelSiblings: string[];
}

interface PendingNode {
  id: string;
  kind: "A" | "B";
}

interface Frame {
  name: string;
  /** 这层（label）子树里依次遇到的 A/B 类节点，扫描结束后才完整 */
  nodes: PendingNode[];
}

/** 摊平 src 下所有「要名字的站点」：裸标签 + 三个共享组件的调用点，带 label 祖先判定。 */
function scanSites(): Site[] {
  const sites: Site[] = [];
  for (const rel of sourceFiles()) {
    if (!rel.endsWith(".tsx")) continue;
    const source = readScannedSource(rel);
    const labelFors = allAttrValues(source, "htmlFor");
    const stack: Frame[] = [];
    /** 本文件的站点先攒引用，等子树扫完（A/B 节点清单完整）再回填判定 */
    const fileSites: Array<Site & { frame?: Frame | null }> = [];
    for (const m of source.matchAll(/<(\/?)([A-Za-z][\w.:-]*)/g)) {
      const name = m[2];
      const at = m.index ?? 0;
      if (m[1]) {
        // 闭合标签：回退到同名开标签，中间的元素一并出栈
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          if (stack[i].name === name) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      const head = tagHead(source, at + m[0].length);
      const line = source.slice(0, at).split("\n").length;
      let labelIdx = -1;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].name === "label") {
          labelIdx = i;
          break;
        }
      }
      const self = `L${line}<${name}>`;
      const kind: PendingNode["kind"] | null = isActionInLabel(name, head.attrs)
        ? "A"
        : isLabelableInLabel(name)
          ? "B"
          : null;
      if (labelIdx >= 0 && kind) stack[labelIdx].nodes.push({ id: self, kind });

      if (CONTROLS.has(name) || SHARED_COMPONENTS.has(name)) {
        const type = attrValue(head.attrs, "type") ?? "";
        if (!(name === "input" && EXEMPT_TYPES.has(type))) {
          const controlId = attrValue(head.attrs, "id");
          const frame = labelIdx >= 0 ? stack[labelIdx] : null;
          const site: Site & { frame?: Frame | null } = {
            file: rel,
            line,
            name,
            type,
            attrs: head.attrs,
            isControl: CONTROLS.has(name),
            viaAria: /(?:^|\s)aria-(label|labelledby)\s*=/.test(head.attrs),
            viaAssociate: controlId !== undefined && controlId !== "" && labelFors.has(controlId),
            viaLabel: labelIdx >= 0,
            viaProp: /(?:^|\s)ariaLabel\s*=/.test(head.attrs),
            labelPolluted: false,
            labelStolen: false,
            labelSiblings: [],
            frame,
          };
          fileSites.push(site);
          sites.push(site);
        }
      }
      if (!head.selfClosing && !CONTROLS.has(name)) stack.push({ name, nodes: [] });
    }
    // 子树扫完：按「位置 + 类别」回填两条 label 判定
    for (const site of fileSites) {
      const nodes = site.frame?.nodes ?? [];
      const self = `L${site.line}<${site.name}>`;
      const mine = nodes.findIndex((node) => node.id === self);
      const before = mine < 0 ? [] : nodes.slice(0, mine);
      const after = mine < 0 ? nodes : nodes.slice(mine + 1);
      site.labelPolluted = [...before, ...after].some((node) => node.kind === "A");
      site.labelStolen = before.some((node) => node.kind === "B");
      site.labelSiblings = [...before.filter((node) => node.kind === "B"), ...[...before, ...after].filter((node) => node.kind === "A")]
        .map((node) => node.id)
        .filter((id) => id !== self);
      delete site.frame;
    }
  }
  return sites;
}

function where(site: Site): string {
  return `${site.file}:${site.line} <${site.name}${site.type ? ` type="${site.type}"` : ""}>`;
}

/**
 * label 文字能不能当这只控件的名字（口径 3）：既要是子树里第一只控件（抢得到隐式关联），
 * 也要 label 里没有动作类内容（名字不会被并进按钮文字）。两条都不满足时退回口径 1/2/4。
 */
function labelNameSource(site: Site): boolean {
  return site.viaLabel && !site.labelPolluted && !site.labelStolen;
}

function hasName(site: Site): boolean {
  return site.viaAria || site.viaAssociate || labelNameSource(site) || site.viaProp;
}

describe("输入控件必须有不消失的可访问名", () => {
  const sites = scanSites();
  const controls = sites.filter((s) => s.isControl);
  const components = sites.filter((s) => !s.isControl);
  const unnamed = sites.filter((s) => !hasName(s));
  const placeholderOnly = controls.filter(
    (s) => attrValue(s.attrs, "placeholder") !== undefined && !s.viaAria && !s.viaAssociate && !labelNameSource(s)
  );
  const titleOnly = sites.filter((s) => attrValue(s.attrs, "title") !== undefined && !s.viaAria && !s.viaProp);
  const checkboxRadio = controls.filter((s) => s.type === "checkbox" || s.type === "radio");
  /** 名字只来自 label、且 label 里坐着动作类内容 = 被按钮污染的框 */
  const pollutedByName = sites.filter((s) => s.labelPolluted && !s.viaAria && !s.viaProp && !s.viaAssociate);
  /** 同 label 里非第一只、名字又只剩 label/placeholder 的框 = 抢不到隐式关联的框 */
  const stolenByName = sites.filter((s) => s.labelStolen && !s.viaAria && !s.viaProp && !s.viaAssociate);
  /** label 内含动作类内容的站点总数（判据有牙的反证，见下方用例） */
  const pollutedSites = sites.filter((s) => s.labelPolluted);
  /** 一只 label 里并排两只控件的站点总数（同上，反证） */
  const stolenSites = sites.filter((s) => s.labelStolen);

  it("扫描要有命中量（口径漂了先在这里红）", () => {
    // 111 → 95：轮67 R67-WP6 把 18 处遮码框收进 PasswordField 一份实现（少 18 个调用点、多 1 个组件本体），是去重不是漏标。
    // PasswordField 不进 SHARED_COMPONENTS：它的名字来源必须是显式 aria-labelledby + 必填 name/autoComplete，
    // 由 passwordFieldsUseSharedComponent 按调用点逐个钉，比这里「在 label 内即算合规」的判据更严。
    expect(controls.length).toBeGreaterThanOrEqual(95);
    expect(components.length).toBeGreaterThanOrEqual(9);
    expect(checkboxRadio.length).toBeGreaterThanOrEqual(20);
    // placeholder 是最容易被误当名字的来源，命中量要够，否则「placeholder 不算名字」那条会空转
    // 45 → 44：轮48 把浏览态 / 编辑态两份重复的查找输入框抽成 FindBar 一份（少一处 placeholder）。
    expect(controls.filter((s) => attrValue(s.attrs, "placeholder") !== undefined).length).toBeGreaterThanOrEqual(44);
  });

  it("不许有没有名字的输入控件或共享组件调用点", () => {
    expect(unnamed.map(where).join("\n")).toBe("");
  });

  it("placeholder 不能单独当名字", () => {
    expect(placeholderOnly.map(where).join("\n")).toBe("");
  });

  it("title 不能单独当名字（波21 修掉的 LanguageSwitch / HistoryView 不许退回）", () => {
    expect(titleOnly.map(where).join("\n")).toBe("");
  });

  it("label 里坐着动作类内容时，label 文字不算名字（R67-WP9）", () => {
    // 全站普查：这种框的名字来源必须是显式 aria-labelledby / ariaLabel / htmlFor 配对。
    // 摘掉任一处（ConnectionManager 本地目录与命名空间、DiffView dataId、PasswordField 本体），
    // 这条当场判红——过去它被「在 label 内」无条件放行，读屏念出来是「标题 + 动作」。
    expect(pollutedByName.map((s) => `${where(s)} ← ${s.labelSiblings.join(" ")}`).join("\n")).toBe("");
    // 反证判据有牙：确实存在「label 内含动作类内容」的框，且它们全靠显式命名活下来。
    // 将来若有人把 label 拆干净，这条下限会提醒回来改判据，而不是留一条空转的用例。
    expect(pollutedSites.length).toBeGreaterThanOrEqual(5);
  });

  it("一只 label 里并排两只控件时，第二只拿不到名字（R67-WP9）", () => {
    // HTML 的隐式 label 关联只认子树里第一个 labelable 后代。
    // 连接表单「项目」栏的下拉框 + 新建文本框就是这种写法：文本框在读屏里彻底没名字。
    // 修法是两只都显式 aria-labelledby 指向标题元素（projectCaptionId）。
    expect(stolenByName.map((s) => `${where(s)} ← ${s.labelSiblings.join(" ")}`).join("\n")).toBe("");
    expect(stolenSites.length).toBeGreaterThanOrEqual(1);
  });

  it("三种命名来源各自都要真有命中，不许全靠一条分支兜住", () => {
    expect(controls.filter((s) => s.viaAria).length).toBeGreaterThanOrEqual(18);
    expect(controls.filter((s) => s.viaAssociate && !s.viaAria).length).toBeGreaterThanOrEqual(4);
    // 88 → 70（WP6 遮码框收进组件少 18 处）→ 64（WP9 把 label 内含按钮那几处挪到显式命名）
    // → 63（WP9 再把「项目」栏并排两只控件里的文本框挪到显式命名）：换的是来源，不是丢名字。
    expect(controls.filter((s) => labelNameSource(s) && !s.viaAria && !s.viaAssociate).length).toBeGreaterThanOrEqual(63);
    // label 包裹不能是全站唯一来源，否则 htmlFor 配对那条判定早就漂了
    expect(controls.filter((s) => s.viaLabel).length).toBeLessThan(controls.length);
  });

  it("共享组件本体必须留着 aria-label 兜底，只许改好不许删", () => {
    const missing = FALLBACK_FILES.filter((file) => !FALLBACK_RE.test(readScannedSource(file)));
    expect(missing.join("\n")).toBe("");
  });

  it("共享组件调用点必须命名：在干净的 <label> 内、显式传 ariaLabel= 或自带 aria-label", () => {
    const naked = components.filter((s) => !labelNameSource(s) && !s.viaProp && !s.viaAria);
    expect(naked.map(where).join("\n")).toBe("");
    const counts: Record<string, number> = {};
    for (const s of components) counts[s.name] = (counts[s.name] ?? 0) + 1;
    // 数量钉死：加调用点要先把名字写好，再回来把数字改上去
    // CodeEditor 第 4 处 = 轮60 微调抽屉，调用点已显式传 ariaLabel={t("diff.manualTuneAria")}
    // NumberField 第 5 处 = 轮99 设置页「每配置保留版数」，调用点显式传 ariaLabel={t("settings.revisionKeep")}
    expect(counts).toEqual({ Combobox: 2, NumberField: 5, CodeEditor: 4 });
  });
});

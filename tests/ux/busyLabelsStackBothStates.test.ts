/**
 * 设置页里「点下去会忙一会儿」的按钮，两档文案必须同占一格（轮74 A3/A4）。
 *
 * 判的是什么：按钮子节点里直接写 `忙 ? t("忙文案") : t("静文案")` ——这种写法在同一帧里
 * 只会有一只标签存在，盒宽跟着文案长度走，用户点下去看到的是「按钮自己变尺寸」。
 * 轮67 给清理缓存补的 `min-width: 106px` 是按一颗按钮、一种语种量的像素，套到别的按钮上
 * 反而更窄（真机：清除本机版本历史 134 → 106），没挂 class 的照样跳（迁移凭据 82 → 80）。
 * 现在统一走 `<BusyLabel>`：两档都留在 DOM 里叠进同一格，宽度恒等于较宽的一档。
 *
 * 口径：
 * 1. 只管**设置页那两个文件**（SettingsView / AppDataBackupPanel）——本轮实测取证的范围；
 *    其余视图（对比、历史、配置浏览）同样有换文案的忙态，量过之后另开一轮再纳入名单。
 * 2. 只看按钮子节点里的三元；属性位上的三元（className / disabled / aria-label）不动宽度，不算。
 * 3. `busy ? … : …` 之外，忙态还必须给得出可见信号：只 `disabled` 不出声的按钮（轮74 A4 的
 *    更改位置… / 打开）由「可见文案由 BusyLabel 提供」这条一起管。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource, stripComments } from "./scanUtils";

const SCOPE = ["src/components/SettingsView.tsx", "src/components/AppDataBackupPanel.tsx"];

/** `<button` 到它自己的 `</button>` 之间的那一段（自闭合按钮不算：按钮必须有可见文字）。 */
function buttonBodies(source: string): Array<{ body: string; offset: number }> {
  const out: Array<{ body: string; offset: number }> = [];
  let cursor = 0;
  for (;;) {
    const open = source.indexOf("<button", cursor);
    if (open < 0) return out;
    const close = source.indexOf("</button>", open);
    if (close < 0) return out;
    out.push({ body: source.slice(open, close), offset: open });
    cursor = close + "</button>".length;
  }
}

/**
 * 按钮里「用三元换文案」的站点。
 * 命中形如 `{expr ? t("a") : t("b")}`，且这段是 JSX 子节点（不是属性值）——
 * 属性值里 t("…") 出现在三元两侧的形状在本仓不存在，出现了也只会被下面这条误报，
 * 而误报会被 `PRE_FIX`/`POST_FIX` 自检立刻暴露。
 */
const LABEL_SWAP = /\{\s*[^{}]*\?\s*t\("[^"]+"\)\s*:\s*t\("[^"]+"\)\s*\}/;

function rawSwapsIn(source: string): number[] {
  const hits: number[] = [];
  for (const { body } of buttonBodies(source)) {
    // BusyLabel 自己不含三元（idle / busyText 各是一个独立属性），所以带它的按钮一定不命中
    if (body.includes("<BusyLabel")) continue;
    if (LABEL_SWAP.test(body)) hits.push(body.length);
  }
  return hits;
}

/** BusyLabel 的调用点：两档文案都必须给全，少一档就等于没钉宽度。 */
function busyLabelCalls(rel: string): string[] {
  const source = stripComments(readScannedSource(rel));
  return Array.from(source.matchAll(/<BusyLabel\b[\s\S]*?\/>/g)).map((m) => m[0]);
}

/** 文件里第一处 BusyLabel 调用（供下面的变异自检拆回裸三元）。 */
function firstBusyLabelCall(rel: string): string {
  const call = busyLabelCalls(rel)[0];
  if (!call) throw new Error(`${rel} 里没有 BusyLabel，自检锚点失效`);
  return call;
}

function rawSwaps(rel: string): number[] {
  return rawSwapsIn(stripComments(readScannedSource(rel)));
}

describe("忙态换文案的按钮两档同占一格（轮74 A3）", () => {
  it("探测器本身有效：修前的写法要被抓、BusyLabel 的写法不抓", () => {
    const pre = '<button type="button">{cacheBusy ? t("settings.clearingCache") : t("settings.clearCache")}</button>';
    const post =
      '<button type="button"><BusyLabel busy={cacheBusy} idle={t("settings.clearCache")} busyText={t("settings.clearingCache")} /></button>';
    // 探测器直接吃字符串片段，口径与上面两个函数一致
    const probe = (markup: string) => !markup.includes("<BusyLabel") && LABEL_SWAP.test(markup.slice(markup.indexOf(">") + 1));
    expect(probe(pre), "修前的原样没被抓，口径漂了").toBe(true);
    expect(probe(post), "BusyLabel 的写法被误抓").toBe(false);
  });

  it("设置页范围内不许再有裸三元的忙态文案", () => {
    const offenders: string[] = [];
    for (const rel of SCOPE) {
      const hits = rawSwaps(rel);
      if (hits.length) offenders.push(`${rel}：${hits.length} 处`);
    }
    expect(offenders, "忙态宽度又交给文案长度决定了自己会跳：\n" + offenders.join("\n")).toEqual([]);
  });

  it("每一处 BusyLabel 都把两档文案给全", () => {
    const problems: string[] = [];
    for (const rel of SCOPE) {
      const calls = busyLabelCalls(rel);
      expect(calls.length, `${rel} 里一处 BusyLabel 都没有，转换被打回了？`).toBeGreaterThan(0);
      calls.forEach((call, index) => {
        const missing = ["busy=", "idle=", "busyText="].filter((prop) => !call.includes(prop));
        if (missing.length) problems.push(`${rel} #${index + 1} 少 ${missing.join(" / ")}`);
        // idle / busyText 必须都走 locale：写死的忙态文案就是轮67 那个 3px 省略号的源头
        const tCount = (call.match(/t\("/g) ?? []).length;
        if (tCount < 2) problems.push(`${rel} #${index + 1} 两档文案没有都从 locale 取（t() 只出现 ${tCount} 次）`);
      });
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("自检：把一处 BusyLabel 拆回裸三元必须判红", () => {
    // 探测器只认「按钮子节点里的三元」，真文件里全换成 BusyLabel 后它读到的永远是 0——
    // 不拿真源码变异一次，就分不清「修好了」和「口径瞎了」。
    const rel = SCOPE[0];
    const source = readScannedSource(rel);
    const call = firstBusyLabelCall(rel);
    const busy = /busy=\{([\s\S]*?)\} idle=\{t\("([^"]+)"\)\} busyText=\{t\("([^"]+)"\)\}/.exec(call.replace(/\s+/g, " "));
    expect(busy, `拆不出三个属性，锚点写法变了：${call.slice(0, 90)}`).toBeTruthy();
    const ternary = `{${busy![1]} ? t("${busy![3]}") : t("${busy![2]}")}`;
    const mutated = source.replace(call, ternary);
    expect(mutated, "变异锚点没命中").not.toBe(source);
    expect(rawSwapsIn(stripComments(mutated)), "拆回裸三元后仍然 0 命中，口径是瞎的").toHaveLength(1);
    expect(rawSwaps(rel), "现状本来就红，这条守卫失去意义").toEqual([]);
  });

  it("BusyLabel 的实现：两档都在 DOM 里，只有一档进可访问名", () => {
    const source = readScannedSource("src/components/BusyLabel.tsx");
    expect(source).toContain('className="busy-label-stack"');
    const options = Array.from(source.matchAll(/<span className="busy-label-option"[^>]*>/g));
    expect(options, "两档标签不是两个兄弟 span").toHaveLength(2);
    for (const option of options) {
      expect(option[0], "可见性要靠 data-shown，宽度才有得比").toContain("data-shown=");
      expect(option[0], "不可见那一档必须同时挂 aria-hidden（jsdom 不做外链样式表级联）").toContain("aria-hidden=");
    }
  });

  it("轮67 那套按单颗按钮量的像素地板不许回来", () => {
    const css = stripComments(readScannedSource("src/styles.css"));
    expect(css, ".settings-busy-btn 又被加回来了——它只对一颗按钮是对的").not.toContain(".settings-busy-btn");
    expect(css).toMatch(/\.busy-label-option\[data-shown="false"\]\s*\{\s*visibility:\s*hidden/);
  });
});

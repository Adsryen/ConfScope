/**
 * 「输入即搜」的两个输入框必须走同一套输入法闸门（轮66 WP-6）。
 *
 * 缺陷长什么样：浏览页的配置搜索与对比页的跨项内容搜索各自写了一份
 * `clearTimeout + window.setTimeout`，只做到「防抖」，没做到「等上屏」。
 * Chromium 在组合期间每敲一个拼音字母都派发一次 input，于是搜「备份」会先拿
 * `b`/`be`/`bei`/`beiw` 各查一遍：列表必然 0 命中、闪一下「没有结果」，
 * 内容搜索还要把每份正文重扫一次。用户读到的是「我还没打完它就说搜不到」。
 *
 * 钉三条形状，不钉性能数字：
 * 1. 两个宿主都必须用 src/lib/deferredSearchInput.ts 这一份编排，且把
 *    compositionStart/End 真的接到那颗 input 上——只在 lib 里实现而调用点没接，等于没修。
 * 2. 组合态判定只许住在 lib 里（composingRef 不许在别处再现第二份）。
 * 3. 搜索侧不许再出现自己持有定时器的写法：这两个文件里 `*Timer.current = window.setTimeout`
 *    只许留 DiffView 那颗与搜索无关的定位闪烁定时器（名单见 ALLOWED_OWN_TIMERS）。
 *    口径是「回显永远即时，搜索永远等上屏」，Enter/搜索按钮走 runNow 不等。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource } from "./scanUtils";

const POLICY = "src/lib/deferredSearchInput.ts";
const HOSTS = ["src/components/ConfigBrowser.tsx", "src/components/DiffView.tsx"];
/** 与搜索无关、允许继续自己持有定时器的 ref（DiffView 命中定位的闪烁动画）。 */
const ALLOWED_OWN_TIMERS = ["flashTimerRef"];

/** 取赋值号左侧的 ref 名：`xxx.current = window.setTimeout(`。 */
function ownedTimerRefs(source: string): string[] {
  const found: string[] = [];
  const re = /([A-Za-z_$][\w$]*)\.current\s*=\s*window\.setTimeout\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) found.push(m[1]);
  return found;
}

describe("输入即搜的输入法闸门不许退回裸防抖（轮66 WP-6）", () => {
  it("共享编排自己成立：组合态撤排期、上屏按最终值补排、runNow 不等", () => {
    const policy = readScannedSource(POLICY);
    expect(policy).toContain("composingRef");
    expect(policy).toContain("onCompositionEnd");
    // delayMs<=0 必须直接透传，不能白排队一个定时器（与轮29 F-16 同口径）
    expect(/if\s*\(delayMs\s*<=\s*0\)/.test(policy)).toBe(true);
  });

  it("两个宿主都接了闸门，且接在真正那颗输入框上", () => {
    for (const file of HOSTS) {
      const source = readScannedSource(file);
      expect(source, `${file} 必须用共享编排`).toContain("useDeferredSearchInput");
      // 事件绑定必须出现在 JSX（带 = 的那一侧），只在注释里提一句不算接
      expect(source, `${file} 缺 onCompositionStart 绑定`).toMatch(/onCompositionStart=\{/);
      expect(source, `${file} 缺 onCompositionEnd 绑定`).toMatch(/onCompositionEnd=\{/);
      // 上屏值取输入框当前值，不依赖 input 与 compositionend 的先后顺序
      expect(source, `${file} 的 onCompositionEnd 没把输入框当前值传进去`).toMatch(
        /onCompositionEnd=\{[\s\S]{0,120}?currentTarget\.value/
      );
    }
  });

  it("搜索侧不许再自己持有定时器，回显走即时 setState", () => {
    for (const file of HOSTS) {
      const owned = ownedTimerRefs(readScannedSource(file)).filter((name) => !ALLOWED_OWN_TIMERS.includes(name));
      expect(owned, `${file} 里这些定时器又回到自己持有：${owned.join(", ")}`).toEqual([]);
    }
  });

  it("组合态判定只许有一份实现", () => {
    const others = HOSTS.filter((file) => readScannedSource(file).includes("composingRef"));
    expect(others, "组合态状态被复制进了视图").toEqual([]);
  });
});

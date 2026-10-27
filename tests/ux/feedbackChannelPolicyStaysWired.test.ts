/**
 * 三条反馈通道的口径守卫（轮94）。
 *
 * 缺陷长什么样：`reportMessage` 无条件附带一条 toast（`notify()` 早期只看 `toast === false`），
 * 于是启动后 5 分钟的「发现新版本」、本机数据写盘重试失败这类**用户没在等它的时刻**发生的事，
 * 和他刚点下去的那颗按钮的结果挤在同一个顶部堆叠里 —— 轮74 判推后时记的那句代价
 * 「启动提示会压住用户自己动作的结果」就是这么来的。这类退化不改渲染、不报错，
 * 只要有人在别处再搓一份 `origin === "system"` 的判断，口径立刻分叉，只能静态钉。
 *
 * 口径（正文见 `.trellis/spec/frontend/feedback-channels.md`）：
 * 1. 「该不该占即时通道」只许写在 `src/lib/errorCenter.ts` 的 `shouldAnnounce()` 里，判定式全站唯一；
 * 2. 系统自发的站点名单钉死（文件 + 命中次数）：新长出一处必须登记，漏登记即红；
 * 3. 即时通道的文案不许把合并次数写进去 —— 文案每次不同，`lib/toast` 的 1.5s 合并窗口就永远命中不了；
 * 4. 静默登记必须换回等值的可见性：未读数有常驻 live region，且不许用 `display:none` 把活区摘掉；
 * 5. 防守卫永真：修前的三种形状都要被探测器抓到，名单里每一项都要仍命中真实代码。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT, loadLocale, readScannedSource } from "./scanUtils";

const DECISION = "src/lib/errorCenter.ts";

/** 系统自发站点名单：`origin: "system"` 的落点与应出现次数（剥注释后统计，示例注释不算命中）。 */
const SYSTEM_SITES: { file: string; count: number; why: string }[] = [
  { file: "src/App.tsx", count: 3, why: "启动数据提示的两种去向（损坏回退 / 恢复与导入）+ 后台检查更新" },
  { file: "src/lib/appDataDoc.ts", count: 1, why: "debounce 推送重试耗尽后的写盘失败" },
];

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** 取 `anchor` 之后到 `endAnchor` 之前的片段（用于「这一段里不许出现 X」这类局部约束）。 */
function blockBetween(source: string, anchor: string, endAnchor: string): string {
  const start = source.indexOf(anchor);
  if (start === -1) return "";
  const end = source.indexOf(endAnchor, start);
  return source.slice(start, end === -1 ? source.length : end);
}

describe("即时通道的判定式全站唯一", () => {
  it("shouldAnnounce 只在 errorCenter 定义，别处没有第二份判定", () => {
    const decision = readScannedSource(DECISION);
    expect(countOccurrences(decision, "export function shouldAnnounce("), "判定式必须导出且只有一处定义").toBe(1);
    expect(countOccurrences(decision, '=== "system"'), "口径分支只许写在判定式里").toBe(1);

    const clones = ["src/App.tsx", "src/lib/appDataDoc.ts", "src/components/MessageCenter.tsx", "src/components/Toaster.tsx"].filter(
      (file) => {
        const text = readScannedSource(file);
        return text.includes('origin === "system"') || text.includes('level === "error" || level === "warning"');
      }
    );
    expect(clones, "有人又搓了一份准入判断：判定式必须收在 errorCenter").toEqual([]);
  });

  it("notify 走判定式，不再无条件播报", () => {
    const decision = readScannedSource(DECISION);
    const notify = blockBetween(decision, "function notify(", "export function subscribeErrors");
    expect(notify, "notify 找不到：判定被挪走了").toContain("shouldAnnounce(input, item.level)");
    expect(notify).not.toContain("if (input.toast === false) return;");
  });

  it("探测器不瞎：修前的三种形状都要被抓到", () => {
    // ① 修前的 notify 只有 `toast === false` 一票否决，没有判定式 —— 本次那条反向钉必须能因此判红
    const beforeNotify = blockBetween(
      "function notify(item, input) {\n  if (input.toast === false) return;\n  toast(text, type);\n}",
      "function notify(",
      "export function subscribeErrors"
    );
    expect(beforeNotify).toContain("if (input.toast === false) return;");
    expect(beforeNotify.includes("shouldAnnounce("), "修前形状应当不含判定式，否则这条反向钉是永真的").toBe(false);

    // ② 有人把判定搬到组件里：`origin === "system"` 的第二份判断必须被扫到
    const clone = 'if (props.origin === "system" && level !== "error") return;';
    expect(clone.includes('origin === "system"'), "第二份判定的形状必须能被识别").toBe(true);

    // ③ 活区被条件渲染掉（等于没有活区）的形状
    const gone = '<div>{unread > 0 && <span role="status" aria-live="polite">x</span>}</div>';
    expect(gone.includes("{unread > 0 &&"), "活区整块消失的形状必须能被识别").toBe(true);

    // ④ 名单条目数与真实命中同源：少登记一处、多长出一处都要红
    const declared = SYSTEM_SITES.reduce((sum, site) => sum + site.count, 0);
    expect(declared).toBe(4);
    for (const site of SYSTEM_SITES) {
      const text = readScannedSource(site.file);
      expect(countOccurrences(text, 'origin: "system"'), `${site.file} 的系统自发站点数对不上（${site.why}）`).toBe(site.count);
    }
  });
});

describe("系统自发事件不占即时通道，但必须看得见", () => {
  it("App.tsx 的启动数据提示登记进消息中心，不再用裸 toast 一闪而过", () => {
    const app = readScannedSource("src/App.tsx");
    // 收尾锚点必须是代码而不是注释：readScannedSource 会剥掉注释，用注释当锚点会一路取到文件末尾
    const notice = blockBetween(app, "const notice = consumeAppDataDocNotice();", "}, [t]);");
    expect(notice, "启动提示找不到：锚点漂了").toContain("consumeAppDataDocNotice()");
    expect(notice.includes("toast("), "启动提示又回到一次性 toast：它必须进登记簿").toBe(false);
    expect(countOccurrences(notice, 'origin: "system"')).toBe(2);
    expect(notice).toContain('level: "error"');
    expect(notice).toContain('level: "info"');
  });

  it("合并次数不写进 toast 文案，× N 交给 toast 层", () => {
    for (const file of ["zh-CN.json", "en-US.json"]) {
      const locale = loadLocale(file);
      expect(locale["messageCenter.toastRecordedWithCount"], `${file}：带次数的文案键不许复活`).toBeUndefined();
      expect(locale["messageCenter.toastRecorded"], `${file}：指路那半句还在，登记簿入口靠它带人过去`).toBeTruthy();
      expect(locale["messageCenter.unreadAnnounce"], `${file}：未读播报缺文案`).toBeTruthy();
      expect(locale["messageCenter.unreadAnnounceOne"], `${file}：单条未读的英文要能念对数`).toBeTruthy();
    }
    const decision = readScannedSource(DECISION);
    expect(decision.includes("toastRecordedWithCount"), "判定实现里还在引用次数文案：会被合并刷屏").toBe(false);
  });

  it("未读数有常驻 live region，且不是靠 display:none 假装存在", () => {
    const center = readScannedSource("src/components/MessageCenter.tsx");
    const live = blockBetween(center, '<span className="message-live"', "{open && (");
    expect(live, "找不到未读播报的活区").toContain('role="status"');
    expect(live).toContain('aria-live="polite"');
    expect(live).toContain("unread > 0");
    // 常驻：0 条时渲染空串而不是整块不渲染，否则内容插入前活区不存在，读屏念不到
    expect(live, "活区被条件渲染掉 = 没有活区").not.toContain("{unread > 0 &&");

    const css = readFileSync(join(PROJECT_ROOT, "src/styles.css"), "utf8");
    const rule = css.slice(css.indexOf(".message-live {"), css.indexOf("}", css.indexOf(".message-live {")));
    expect(rule, "styles.css 里找不到 .message-live").toContain("clip-path");
    expect(rule.includes("display: none"), "display:none 会把活区从无障碍树里摘掉").toBe(false);
  });
});

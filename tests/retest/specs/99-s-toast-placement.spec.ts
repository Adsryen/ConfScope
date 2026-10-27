// 轮94 D1 真机落位探针：即时播报（toast）到底有没有压住用户要点的东西。
//
// 为什么这一轮必须把它量出来，而不是继续用「顶部居中看起来挺合理」说话：
// 轮74 判 D1 推后时记下的代价是「启动提示会压住用户自己动作的结果」，那笔账的
// **一半**（该不该播报）本轮由口径改动收了（口径正文见 `.trellis/spec/frontend/feedback-channels.md`），
// **另一半**（播报出现时占的是哪块地方）一直没人量过。`.toaster` 是
// `position:fixed; top:18px; left:50%`（src/styles.css），顶部正中正是各页工具条/步骤条的位置
// ——是不是真压住可交互控件，可以判定，不该算主观之争。
//
// 量法（先把口径钉死，避免「blocked=0」只是探针空转）：
//   · 候选 = 当前可见页面上的可交互节点（button/input/select/textarea/a[href]/role=button|tab|combobox|switch|checkbox|[contenteditable]），
//     排除 `.toaster` 自己。不可见（rect 为 0 / visibility:hidden / 累积 opacity<0.05）一律不算——
//     计划页与对比页常驻保活，切走后 DOM 还在，不限定可见就把看不见的控件算成遮挡（假阳性）。
//   · `overlap`（视觉碰撞）：候选矩形与本条 toast 矩形的相交面积 ≥ minOverlapArea。
//   · `blocked`（真遮挡，本用例唯一该红的东西）：候选**中心点**的 document.elementFromPoint 落进 toast 里
//     ⇒ 用户按惯常落点点不动。禁用/只读/降透明记进 inactive 桶（与 WCAG 1.4.3 的非活动豁免同源），只记不修。
//   · 用中心点而不是「相交过半」：盖住一半时另外一半仍可点，但那不是用户会去点的地方——
//     这种形状必须能被抓到，见下面的 canary。
//
// 自证非恒真（canary，两个视口各跑一次）：真实 toast 出现后，把「这条被测 toast 自己」用 transform
// 平移到某个已知启用的可见控件中心上，那个控件必须进 blocked（按元素身份判定，不靠文案匹配）；随后清掉
// 行内 transform。平移对象不能是 `.toaster` 容器——它是 flex 列，上面压着别的 toast 时动容器永远对不准
// （三轮踩坑记录见 runCanary 上方注释）。这条是探针的保险丝：探测器抓不到已知遮挡时，「blocked=0」的绿灯都不作数。
//
// 环境自证：每档先断言 #root 有子节点、`.toaster` 存在，再谈 toast 有没有弹。
// 轮94 第一次跑就是因为这两条缺失，把「关于页因桥缺绑定替身而白屏」误报成「toast 没渲染」。
import { expect, test } from "./retestTest";
import type { Page } from "@playwright/test";
import { installRetestBridge } from "../bridge/installRetestBridge";
import { republishRetestData } from "../bridge/republishData";
import { navigate, dismissStartupDialog, setDiffSource } from "./ui";

/** 1280x820 = main.go 的默认窗口；960x600 = main.go 的 MinWidth/MinHeight（真实下限，不是随手取的窄档）。 */
const VIEWPORTS = [
  { label: "1280x820", width: 1280, height: 820 },
  { label: "960x600", width: 960, height: 600 },
];

/** 与 99-s-contrast 同源的 11 个视图（侧栏真人点击路径）。 */
const VIEWS = ["配置浏览", "配置对比", "配置矩阵", "操作历史", "备份快照", "任务中心", "审计日志", "连接管理", "SSH 隧道", "设置", "关于"];

interface PlacementOpts {
  /** 只认这条文案对应的 toast（页面上可能同时有别的真实提示）。 */
  marker: string;
  /** 相交面积地板（px²）：1px 的舍入抖动不该算碰撞。 */
  minOverlapArea: number;
}

interface PlacementHit {
  label: string;
  tag: string;
  cls: string;
  overlap: number;
  /** 中心点被 toast 接走 = 真遮挡 */
  blocked: boolean;
  /** 禁用/只读：记档不判红 */
  inactive: boolean;
  /** canary 对照组的靶子（按元素身份判定，不靠文案匹配 —— 文案会被 × N 合并与空白规范化干扰） */
  canary: boolean;
  /** 这颗控件在打开的弹框里（`.modal-overlay`/`.startup-overlay`）：判据要分桶，见 blockedBase/blockedInModal */
  inModal: boolean;
}

/** 一档的读数：视口/视图 + toast 落位矩形 + 三个分桶。 */
interface Reading {
  viewport: string;
  view: string;
  toast: PlacementReport["toast"];
  candidates: number;
  blocked: string[];
  blockedInModal: string[];
  blockedInactive: string[];
  overlapOnly: string[];
}

interface PlacementReport {
  /** 环境自证：读不到 .toaster 与「整棵应用被卸载」是两种完全不同的事故，必须分开报。
   *  轮94 第一次跑就是栽在这里 —— 关于页因为复测桥缺绑定替身而白屏，探针只表现为
   *  「toast 等 5s 没出现」，看不出是提示没弹还是页面没了。 */
  toasterPresent: boolean;
  rootChildCount: number;
  bodyTextLength: number;
  toast: { left: number; top: number; right: number; bottom: number; w: number; h: number } | null;
  candidates: number;
  hits: PlacementHit[];
  blocked: string[];
  blockedInModal: string[];
  blockedInactive: string[];
  overlapOnly: string[];
}

/** 浏览器侧执行：必须自包含（不能引用外部作用域），阈值一律经参数传入。 */
function measurePlacement(o: PlacementOpts): PlacementReport {
  const rootEl = document.getElementById("root");
  const env = {
    toasterPresent: !!document.querySelector(".toaster"),
    rootChildCount: rootEl ? rootEl.children.length : -1,
    bodyTextLength: (document.body.innerText || "").trim().length,
  };
  const empty: PlacementReport = {
    ...env,
    toast: null,
    candidates: 0,
    hits: [],
    blocked: [],
    blockedInModal: [],
    blockedInactive: [],
    overlapOnly: [],
  };
  const toaster = document.querySelector(".toaster");
  if (!toaster) return empty;
  const toasts = Array.from(toaster.querySelectorAll<HTMLElement>(".toast")).filter((el) => el.textContent?.includes(o.marker));
  if (!toasts.length) return empty;

  // 多条同文案（合并成 × N 之前的堆叠）取并集，判据一致
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const el of toasts) {
    const r = el.getBoundingClientRect();
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top) return empty;

  const SELECTOR = [
    "button",
    "input",
    "select",
    "textarea",
    "a[href]",
    '[role="button"]',
    '[role="tab"]',
    '[role="combobox"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[contenteditable="true"]',
  ].join(",");

  const chainOpacity = (el: Element) => {
    let v = 1;
    let cur: Element | null = el;
    while (cur) {
      v *= Number(getComputedStyle(cur).opacity || "1");
      cur = cur.parentElement;
    }
    return v;
  };
  const inToast = (el: Element | null) => {
    let cur: Element | null = el;
    while (cur) {
      if (cur.classList && cur.classList.contains("toast")) return true;
      cur = cur.parentElement;
    }
    return false;
  };
  const labelOf = (el: HTMLElement) => {
    const t = (el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || "").trim();
    if (t) return t.slice(0, 40);
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (txt) return txt.slice(0, 40);
    const v = (el.getAttribute("value") || "").trim();
    return v ? v.slice(0, 40) : el.className ? `(${String(el.className).slice(0, 40)})` : "(无标签)";
  };

  const all = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR));
  const hits: PlacementHit[] = [];
  let candidates = 0;
  for (const el of all) {
    if (el.closest(".toaster")) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (getComputedStyle(el).visibility === "hidden") continue;
    if (chainOpacity(el) < 0.05) continue; // 折叠/保活隐藏：口径同 99-s-contrast 的 C 桶
    candidates += 1;

    const ix = Math.max(0, Math.min(r.right, right) - Math.max(r.left, left));
    const iy = Math.max(0, Math.min(r.bottom, bottom) - Math.max(r.top, top));
    const area = ix * iy;
    if (area < o.minOverlapArea) continue;

    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const inViewport = cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight;
    const hitEl = inViewport ? document.elementFromPoint(cx, cy) : null;
    const blocked = inViewport && inToast(hitEl);
    const disabled =
      (el as HTMLButtonElement).disabled === true ||
      el.getAttribute("aria-disabled") === "true" ||
      el.getAttribute("readonly") !== null ||
      (el as HTMLInputElement).readOnly === true;

    hits.push({
      label: labelOf(el),
      tag: el.tagName.toLowerCase(),
      cls: String(el.className || "").slice(0, 60),
      overlap: Math.round(area),
      blocked,
      inactive: disabled,
      canary: el.hasAttribute("data-canary-target"),
      inModal: !!el.closest(".modal-overlay, .startup-overlay"),
    });
  }

  return {
    ...env,
    toast: {
      left: Math.round(left),
      top: Math.round(top),
      right: Math.round(right),
      bottom: Math.round(bottom),
      w: Math.round(right - left),
      h: Math.round(bottom - top),
    },
    candidates,
    hits,
    blocked: hits.filter((h) => h.blocked && !h.inactive && !h.inModal).map(hitText),
    blockedInModal: hits.filter((h) => h.blocked && !h.inactive && h.inModal).map(hitText),
    blockedInactive: hits.filter((h) => h.blocked && h.inactive).map(hitText),
    overlapOnly: hits.filter((h) => !h.blocked).map(hitText),
  };

  /**
   * 四个桶共用同一个读数格式：`<可见文案> [<tag>.<class>] <相交面积>px²`。
   *
   * 为什么要统一（final4 踩的坑）：blocked 曾写作 `<label> [tag.cls]`、overlapOnly 写作
   * `<label> 2022px²`，而 ACCEPTED_BLOCKED 的匹配键是 `<label> [` 前缀 —— 于是「邻接
   * （overlapOnly）」这一档永远匹配不上登记，例外被误判成"过期例外"红掉。格式各写各的
   * = 例外机制对其中一个桶静默失效，正是这套登记想防的那种假红/假绿。
   *
   * 必须定义在 evaluate 内部：page.evaluate 只序列化这一个函数，模块作用域的辅助函数
   * 在页面里不存在（final5 第一次跑就是这么炸成 ReferenceError 的）。
   */
  function hitText(h: PlacementHit): string {
    return `${h.label} [${h.tag}.${h.cls}] ${h.overlap}px²`;
  }
}

/**
 * 触发一条真实 toast：走 `src/lib/toast.ts` 的公开 `toast()`（产品按钮点下去之后就是同一条管道），
 * 不是造一个假浮层。vite dev 下模块 URL 与应用 import 同源 ⇒ 同一个实例；
 * 万一哪天不同源（toast 不渲染），紧随其后的 waitFor 直接炸，不会留下「量了个空」的假绿。
 */
/**
 * 说明符必须保持非字面量：`import("/src/lib/toast.ts")` 是 vite dev server 的模块 URL，
 * 不是文件系统路径。tsc（tsconfig.tests.json 把 tests/ 纳进门禁）解析不了它，写成字面量
 * 会让 `pnpm typecheck` 直接 TS2307 红；类型靠各调用点紧随其后的 cast 兜住。
 */
const TOAST_MODULE_URL = "/src/lib/toast.ts";

async function showToast(page: Page, marker: string): Promise<number> {
  const id = await page.evaluate(
    async ({ url, text }) => {
      const mod = (await import(url)) as {
        toast: (t: string, type?: string) => number;
        hold: (id: number) => void;
        clearToasts: () => void;
      };
      // 先清场：上一条还在倒计时里就会把被测条顶下去（`.toaster` 是 flex 列），
      // 实测能把手臂上的 canary 命中集打空。探针要的是"这一条压在哪"，不是堆叠美学。
      mod.clearToasts();
      const newId = mod.toast(text, "info");
      // hold 停掉 2600ms 倒计时：aim 与 measure 是两次 round trip，慢机上会在这两次之间过期，
      // "toast 走完了"会被读成"探针失效"。悬停暂停本来就是产品行为（lib/toast 的 hold/release），
      // 这里只是把它固定住，落位与遮挡判据都不变。
      mod.hold(newId);
      return newId;
    },
    { url: TOAST_MODULE_URL, text: marker }
  );
  await expect(page.locator(".toaster .toast", { hasText: marker }).first()).toBeVisible({ timeout: 5_000 });
  return id;
}

/** 撤掉探针自己挂上去的那条（held 的不会自己走，必须显式 dismiss，否则下一档带着上一条一起量）。 */
async function dismissToast(page: Page, id: number): Promise<void> {
  await page.evaluate(
    async ({ url, toastId }) => {
      const mod = (await import(url)) as { dismiss: (id: number) => void };
      mod.dismiss(toastId);
    },
    { url: TOAST_MODULE_URL, toastId: id }
  );
}

async function measureWithToast(page: Page, marker: string): Promise<PlacementReport> {
  const id = await showToast(page, marker);
  try {
    return await readPlacement(page, marker);
  } finally {
    await dismissToast(page, id);
  }
}

async function readPlacement(page: Page, marker: string): Promise<PlacementReport> {
  const report = await page.evaluate(measurePlacement, { marker, minOverlapArea: 24 } satisfies PlacementOpts);
  // 先判环境，再判 toast：白屏必须炸成「页面没了」，不许伪装成「提示没出现」
  expect(
    report.rootChildCount,
    `页面是白屏：#root 子节点数 ${report.rootChildCount}（0 = 整棵应用被卸载，通常是渲染阶段同步抛错；先查 PAGEERROR 再看 toast）`
  ).toBeGreaterThan(0);
  expect(report.toasterPresent, ".toaster 容器不存在：ToastProvider 没挂载或被卸载，落位探针无从测量").toBe(true);
  return report;
}

/**
 * canary：先出真实 toast，再把「这条被测 toast 自己」平移，让它的中心正好压在某个已知启用、
 * 可见的可交互控件中心上，那个控件必须判成 blocked（按元素身份判定，不靠文案匹配）。
 * 这一条是探针的保险丝：canary 不成立 ⇒ blocked=0 的所有绿灯都不作数。
 *
 * 三个踩过的坑都写在这儿，别再退回去：
 *   1. 首版拿另一条 holder toast 的高度算位置 —— 中心点根本不在被测矩形里。
 *   2. 第二版只平移容器 `top` —— 实测靶子「retest-dev（16）▾」在 right:1068..1258，
 *      toast 在 left:551..728，相交面积 0px²，canaryHits 空集：横轴不动等于没瞄准。
 *   3. 第三版改容器 `left`/`top` 双轴 —— 残留 0.4/162.7px。容器是 flex 列，上面还压着
 *      别的 toast，动容器是把 holder 一起搬，被测条始终落不回靶心；横轴那 0.4px 是
 *      靶子恰好站在视口中线上的假象（容器本来就是 left:50% 居中）。
 *      所以平移对象只能是那一条 `.toast` 本身，且必须先关掉 `animation`/`transition`
 *      —— 入场动画期间的 transform 会盖掉行内值，读到的矩形是动画中间帧。
 * 断言分两层：先看有没有残留（瞄准是否成立），再看 blocked（探测器是否看得见）——
 * 否则「瞄准失败」会被读成「探针失效」，白折腾一轮。
 */
async function runCanary(page: Page, marker: string, done: string[]): Promise<void> {
  const picked = await page.evaluate(() => {
    const pool = Array.from(document.querySelectorAll<HTMLElement>("button, input, select, textarea")).filter((el) => {
      if (el.closest(".toaster")) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (el as HTMLButtonElement).disabled !== true && r.top >= 0 && r.top < window.innerHeight;
    });
    if (!pool.length) return null;
    // 取视口里最靠上的一颗：顶部 chrome 的按钮正是 toast 会压到的那一族
    const el = pool.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
    el.setAttribute("data-canary-target", "1");
    const r = el.getBoundingClientRect();
    const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    return { label, cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
  });
  expect(picked, "canary：视口里找不到一颗启用的可交互控件，对照组无从构造").not.toBeNull();

  const toastId = await showToast(page, marker);

  // 瞄准：把「这条被测 toast 自己」的中心平移到靶子中心；读残留并自校正一次（残留>2px 就不许再往下判）
  //
  // 平移对象必须是被测那一条，不能是 `.toaster` 容器：容器是 flex 列，排在它上面的其它 toast
  // （启动/后台任务弹出来的）会把被测条整体顶下去，动容器就等于带着 holder 一起动，
  // 中心点永远对不上靶子（实测残留 0.4/162.7px，横轴看着"中"纯属靶子恰好在视口中线上）。
  const aim = await page.evaluate(
    (o: { marker: string }) => {
      const place = () => {
        const toaster = document.querySelector(".toaster") as HTMLElement | null;
        const toastEl = Array.from(toaster?.querySelectorAll<HTMLElement>(".toast") ?? []).find((el) => el.textContent?.includes(o.marker));
        const target = document.querySelector<HTMLElement>("[data-canary-target]");
        if (!toastEl || !target) return null;
        const tr = target.getBoundingClientRect();
        const tcx = tr.left + tr.width / 2;
        const tcy = tr.top + tr.height / 2;
        // 关掉入场动画与过渡：动画期间的 transform 会盖掉行内值，读到的矩形是动画中间帧。
        // 先复位再量自然矩形：本函数会被调两次做自校正，若不先清掉上一轮的行内 transform，
        // 第二轮量到的"当前矩形"已经含上一轮位移，增量归零后整条被覆盖回原位（实测残留 -558.7/7.5px）。
        toastEl.style.transition = "none";
        toastEl.style.animation = "none";
        toastEl.style.transform = "none";
        const before = toastEl.getBoundingClientRect();
        toastEl.style.transform = `translate(${Math.round(tcx - (before.left + before.width / 2))}px, ${Math.round(
          tcy - (before.top + before.height / 2)
        )}px)`;
        const after = toastEl.getBoundingClientRect();
        return {
          residualX: Math.round((after.left + after.width / 2 - tcx) * 10) / 10,
          residualY: Math.round((after.top + after.height / 2 - tcy) * 10) / 10,
          toast: {
            left: Math.round(after.left),
            top: Math.round(after.top),
            w: Math.round(after.width),
            h: Math.round(after.height),
          },
          target: { left: Math.round(tr.left), top: Math.round(tr.top), w: Math.round(tr.width), h: Math.round(tr.height) },
          // 现场留证：行内值与计算值不一致（动画/!important 抢走了 transform）时，
          // 一眼能看出是"没写上"还是"写了没生效"，不必再来一轮取证
          dbg: { inline: toastEl.getAttribute("style"), computed: getComputedStyle(toastEl).transform },
        };
      };
      const first = place();
      if (!first) return null;
      // 二次校正只在残留明显时发生（例如换行导致宽度变了）
      if (Math.abs(first.residualX) <= 2 && Math.abs(first.residualY) <= 2) return first;
      return place() ?? first;
    },
    { marker }
  );
  expect(aim, "canary：瞄准时找不到被测 toast 或靶子（靶子可能在测量间被 React 重建），对照实验没做成").not.toBeNull();
  expect(
    `${Math.abs(aim!.residualX) <= 2 && Math.abs(aim!.residualY) <= 2}`,
    `canary 没瞄準：残留 ${aim!.residualX}/${aim!.residualY}px，toast 矩形 ${JSON.stringify(aim!.toast)}，` +
      `靶子矩形 ${JSON.stringify(aim!.target)}，dbg ${JSON.stringify(aim!.dbg)} —— 这是瞄准失败，不是探针失效`
  ).toBe("true");

  const during = await readPlacement(page, marker);
  expect(
    during.toast,
    `canary：瞄准刚成立，探测器就量不到这条 toast（aim 现场 ${JSON.stringify(aim!.dbg)}）——` +
      `是提示在两次 round trip 之间被撤掉了，不是遮挡判据失效`
  ).not.toBeNull();
  await page.evaluate((m: string) => {
    const toaster = document.querySelector(".toaster") as HTMLElement | null;
    const toastEl = Array.from(toaster?.querySelectorAll<HTMLElement>(".toast") ?? []).find((el) => el.textContent?.includes(m));
    if (toastEl) {
      toastEl.style.removeProperty("transform");
      toastEl.style.removeProperty("animation");
      toastEl.style.removeProperty("transition");
    }
    document.querySelector("[data-canary-target]")?.removeAttribute("data-canary-target");
  }, marker);
  await dismissToast(page, toastId);

  const canaryHit = during.hits.find((h) => h.canary);
  expect(
    canaryHit,
    `canary 失效：靶子「${picked!.label}」压根没进命中集（aim 时 toast 矩形 ${JSON.stringify(aim!.toast)}，` +
      `测量时 toast 矩形 ${JSON.stringify(during.toast)}，候选 ${during.candidates} 条、命中 ${during.hits.length} 条，` +
      `dbg ${JSON.stringify(aim!.dbg)}）：中心点已对齐却连 24px² 相交都不成立 ⇒ 候选遍历或可见性过滤有问题，blocked=0 的绿灯都不作数`
  ).toBeTruthy();
  expect(
    canaryHit!.blocked,
    `canary 失效：靶子「${picked!.label}」中心点压在被测 toast 里却没判成遮挡（overlap=${canaryHit!.overlap}px²）` +
      `⇒ document.elementFromPoint 这一路判据失效，blocked=0 全是假的`
  ).toBe(true);
  done.push(`${picked!.label}`);
}

/** 单档：出一个真实 toast、量一次、把读数收进表里。环境类断言（白屏/没渲染/零候选）在这里挡住。 */
async function measureOne(page: Page, readings: Reading[], viewport: string, view: string, seq: number): Promise<void> {
  const marker = `轮94落位探针 ${String(seq).padStart(2, "0")}`;
  const report = await measureWithToast(page, marker);
  expect(report.toast, `${viewport}/${view}：toast 没渲染出来，探针在这一档失去意义`).not.toBeNull();
  expect(report.candidates, `${viewport}/${view}：一个可见可交互控件都没量到 ⇒ 候选遍历失效`).toBeGreaterThan(0);
  readings.push({
    viewport,
    view,
    toast: report.toast,
    candidates: report.candidates,
    blocked: report.blocked,
    blockedInModal: report.blockedInModal,
    blockedInactive: report.blockedInactive,
    overlapOnly: report.overlapOnly,
  });
}

/**
 * 从对比页走进变更计划第5步（与 99-s-apply-confirm-copyable 同一条真人路径，只是不需要生产标记）。
 * 走不通就让它自己红：这一档的量法依赖真实计划数据，伪造一屏"计划页"等于没测。
 */
async function openChangePlan(page: Page): Promise<void> {
  await navigate(page, "配置对比");
  await page.waitForTimeout(500);
  await setDiffSource(page, "left", {
    connection: "Retest Nacos A",
    namespace: "retest-dev",
    group: "RETEST-PROD",
    dataId: "svc-gateway.yaml",
  });
  await setDiffSource(page, "right", {
    connection: "Retest Nacos B",
    namespace: "retest-qa",
    group: "RETEST-PROD",
    dataId: "svc-gateway.yaml",
  });
  await page.getByRole("button", { name: "加载并对比" }).last().click();
  await expect(page.locator(".diff-panel")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "进入配置变更计划" }).last().click();
  // 计划页的到达判据用 .apply-ledger/.apply-item-list（与 30-apply 同一口径）。
  // 不能拿 .apply-confirmation-code 当入口判据：那是"受保护目标"才有的确认卡，
  // 要用它得先把右侧连接改名成生产，探针不该为了量位置去改种子数据。
  await expect(page.locator(".apply-ledger, .apply-item-list").first()).toBeVisible({ timeout: 30_000 });
  const selectAll = page.getByRole("button", { name: "全选" }).first();
  if (await selectAll.count()) await selectAll.click();
  await page.waitForTimeout(300);
}

/** 把「执行变更」那颗按钮滚进视口：第5步的手指落点是全程序最贵的一个位置，必须单独量一档。 */
async function scrollToExecuteZone(page: Page): Promise<boolean> {
  const exec = page.locator("button", { hasText: "执行变更" }).last();
  if (!(await exec.count())) return false;
  await exec.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  return true;
}

/**
 * 读数格式的唯一解析口径（与 evaluate 内 hitText 一对一）：`<文案> [<tag>.<class>] <面积>px²`。
 * 解析不出来就地抛错，而不是"匹配不上就算了"—— final4 的教训是格式各写各的会让例外机制
 * 对某个桶静默失效，把真问题伪装成"过期例外"。
 */
const HIT_FORMAT_RE = /^(?<label>.+) \[[^\]]+\] \d+px²$/;
function hitLabel(hit: string): string {
  const m = HIT_FORMAT_RE.exec(hit);
  if (!m) throw new Error(`读数格式不符合 "<文案> [<tag>.<class>] <面积>px²"：${hit}`);
  return String(m.groups!.label);
}

/**
 * 已复核、已认账的落位例外（baseline）。判据仍然是"底层遮挡必须为 0"，这里登记的只是一笔取证过的代价：
 * 任何没在这里出现的新遮挡照样红。
 *
 * 为什么这一档不能简单判红或判绿（final3 全量读数）：960x600 下这条提示的矩形是 782,547..944,591，
 * 而那个 select 的矩形是 753,529..934,560、中心点 (844, 545) —— 中心点与提示上沿只差 2px。
 * 同一份代码连着两次全量跑，一次判成 blocked、一次判成 overlapOnly（覆盖 2022px²，约占该控件 36%）。
 * 也就是说这一档处在探针的刀口上：把判红改成判绿、或反过来，都是在跟着 2px 抖动改口径。
 *
 * 所以例外的匹配键用**控件身份**（label 前缀），命中范围用 blocked ∪ overlapOnly：
 * 只要这颗控件还压在提示的邻接区里，这条登记就算数；哪天它彻底不在这个角落了（布局改了），
 * 登记会因"过期例外"红掉，逼着回来删掉它 —— 既不当免死金牌，也不跟着亚像素抖动翻脸。
 */
const ACCEPTED_BLOCKED: Array<{ shot: string; label: string; reason: string }> = [
  {
    shot: "960x600/连接管理",
    label: "直连 Nacos通过 SSH 隧道",
    reason:
      "最小窗口档（960x600 = main.go 的 MinWidth/MinHeight）下连接表单的字段行铺到窗口右边缘，" +
      "接入方式下拉正好横在右下角提示的邻接带上（中心点距提示上沿 2px，实测在 blocked/overlapOnly 之间抖动）。" +
      "代价：这条提示 2.6s 自动消失、悬停暂停、可点 ×，同一页在 1280x820 档完全不相交。" +
      "解除条件：把瞬时播报挪出内容区（底部常驻状态条那一类方案），或窄窗口下连接表单改成单列，届时删掉这条。",
  },
];

test("轮94 D1 落位普查：即时播报压住底层可交互控件的档位必须为 0", async ({ page, retest }) => {
  test.setTimeout(420_000);
  await installRetestBridge(page, retest);
  await republishRetestData();
  await page.goto("/");
  await page.evaluate(() => window.localStorage.setItem("retest.bridge.marker", "1"));
  await dismissStartupDialog(page);

  const readings: Reading[] = [];
  const canaryDone: string[] = [];
  let seq = 0;

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(400);
    for (const label of VIEWS) {
      await navigate(page, label);
      await page.waitForTimeout(700);
      await measureOne(page, readings, vp.label, label, ++seq);
    }
    // 变更计划页不在侧栏导航里（mode "apply" 只能从对比页的工作流进入），但它才是全程序最贵的一屏：
    // 第5步的「执行变更」按下去就是真写库。落位结论如果不包含这一屏，就只证明了"页面好看"。
    await openChangePlan(page);
    await measureOne(page, readings, vp.label, "变更计划(第5步)", ++seq);
    // 每个视口跑一次 canary（探针保险丝）
    await navigate(page, "配置浏览");
    await page.waitForTimeout(600);
    seq += 1;
    await runCanary(page, `轮94落位探针 ${String(seq).padStart(2, "0")}-canary`, canaryDone);
  }

  console.log(
    `TOAST_PLACEMENT_SUMMARY ${JSON.stringify({
      viewports: VIEWPORTS.map((v) => v.label),
      blockedTotal: readings.reduce((s, r) => s + r.blocked.length, 0),
      blockedInModalTotal: readings.reduce((s, r) => s + (r.blockedInModal || []).length, 0),
      blockedInactiveTotal: readings.reduce((s, r) => s + r.blockedInactive.length, 0),
      overlapOnlyTotal: readings.reduce((s, r) => s + r.overlapOnly.length, 0),
      geometry: readings.map((r) => `${r.viewport}/${r.view}=${JSON.stringify(r.toast)}`),
      rows: readings.map((r) => ({
        view: `${r.viewport}/${r.view}`,
        candidates: r.candidates,
        blocked: r.blocked,
        blockedInModal: r.blockedInModal,
        blockedInactive: r.blockedInactive,
        overlapOnly: r.overlapOnly,
      })),
      canaryDone,
    })}`
  );

  expect(canaryDone.length, "canary 没跑满每个视口档位").toBe(VIEWPORTS.length);

  // 判红只针对底层层级：弹框打开时提示压住弹框内的控件，是"提示必须浮在弹框之上"这条既定层级
  // （报错时「已复制 / 已保存」要看得见，见 toasterStacking 守卫）换来的代价，记档不判红。
  // 分桶依据是命中元素自己 `closest(".modal-overlay, .startup-overlay")` —— 按 DOM 身份分，
  // 不看文案，也不许把它当"反正是弹框"的免死金牌：底层层级只要压住一颗就红。
  //
  // 唯一允许不红的是下面 ACCEPTED_BLOCKED 里**逐条登记过**的那一笔：判据本身不放宽，
  // 登记的门槛是「同一次跑里复现过、矩形取证过、写清了代价与解除条件」。
  // 没登记过的新遮挡照样红；登记过但这次没命中的，也会被"过期例外"那条断言揪出来删掉。
  const unmatched = new Map(ACCEPTED_BLOCKED.map((a) => [`${a.shot} · ${a.label}`, a]));
  const offenders: string[] = [];
  for (const r of readings) {
    const shot = `${r.viewport}/${r.view}`;
    for (const hit of [...r.blocked, ...r.overlapOnly]) {
      const label = hitLabel(hit);
      for (const [key, a] of unmatched) {
        if (key.startsWith(`${shot} · `) && a.label === label) unmatched.delete(key);
      }
    }
    for (const b of r.blocked) {
      const accepted = ACCEPTED_BLOCKED.some((a) => a.shot === shot && a.label === hitLabel(b));
      if (!accepted) offenders.push(`${shot} → ${b}`);
    }
  }
  expect(offenders, "这些档位上即时播报压住了用户要点的东西（中心点被 toast 接走，且不在任何打开的弹框里）").toEqual([]);
  expect(
    Array.from(unmatched.keys()),
    "这些登记过的落位例外这次连邻接都没沾上：说明遮挡已经没了（或元素身份变了），把 ACCEPTED_BLOCKED 里那条删掉，别留着当免死金牌"
  ).toEqual([]);

  const inModal = readings.flatMap((r) => (r.blockedInModal || []).map((b) => `${r.viewport}/${r.view} → ${b}`));
  console.log(`BLOCKED_IN_MODAL ${JSON.stringify(inModal)}`);
});

/**
 * 快速调试入口：`RETEST_PROBE_SMOKE=1` 时只注册「canary + 变更计划档」（约 2 分钟），
 * 不带那 22+2 档全量普查。只在改瞄准逻辑或改计划页进入路径时用；
 * 出正式读数的跑法必须不带这个环境变量，否则会悄悄丢掉普查。
 */
if (process.env.RETEST_PROBE_SMOKE === "1") {
  test("轮94 D1 落位探针（canary + 变更计划档 · 调试用）", async ({ page, retest }) => {
    test.setTimeout(240_000);
    await installRetestBridge(page, retest);
    await republishRetestData();
    await page.goto("/");
    await dismissStartupDialog(page);
    const readings: Reading[] = [];
    const done: string[] = [];
    let seq = 0;
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await navigate(page, "配置浏览");
      await page.waitForTimeout(600);
      await runCanary(page, `轮94落位探针 ${String(++seq).padStart(2, "0")}-canary`, done);
      await openChangePlan(page);
      await measureOne(page, readings, vp.label, "变更计划(计划区)", ++seq);
      if (await scrollToExecuteZone(page)) {
        await measureOne(page, readings, vp.label, "变更计划(执行区)", ++seq);
      }
    }
    console.log(`SMOKE_RESULT ${JSON.stringify({ canary: done, readings })}`);
  });
}

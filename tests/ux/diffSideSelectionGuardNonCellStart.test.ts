/**
 * @vitest-environment jsdom
 *
 * r134：对比流程里「只想复制一侧，结果两侧同时被选中复制走」。
 *
 * 机制层判据——起手落点必须被分到侧。并排 diff 的每一行里
 * 「左行号 → 左 cell → 合并箭头 → 右行号 → 右 cell」是同一行的兄弟节点，选区取的是
 * 文档序区间：守卫类一被清空，这一次拖选两侧的正文就都可选，复制出来左右粘在一起。
 * 而行号槽 / 合并箭头列 / 行间空白**也在 .diff-body 内**——真人从行号起手往下拖是
 * 最常见的抓块动作，落点却不在任何 .diff-cell 里。旧实现把这类落点判成「侧未知」
 * 直接清空守卫类，等于把这一次拖选放行了。本文件钉住：
 *  - 落点在 .diff-body 内、且在正文格里 → 按格子分侧（既有行为，不许回归）；
 *  - 落点在 .diff-body 内、但不在正文格里 → 必须仍分到某一侧（横向中线兜底：
 *    左半屏归左、右半屏归右），不许清空；
 *  - 落点完全在本 body 之外 → 清空（不替用户做主，既有行为）；随后按住拖进 body
 *    时，指针所在侧必须被补分（真人从头部标签栏 / 正文上方起手往下拖是常见手势，
 *    只在 pointerdown 那一刻判定会放过整次拖选）；已分到侧后移动指针不许偷换侧。
 *  - 键盘路径（选区起点在左格）兜底分侧；卸载后监听撤净、类也撤净。
 *
 * jsdom 没有布局引擎也没有真实选区高亮：getBoundingClientRect 手工给值，
 * 事件是带坐标的 pointerdown（守卫只读 target 与 clientX）。
 * CSS 侧的选择器由 diffSideSelectionGuardStaysWired 钉住；
 * 真实选区文本读数在 tests/retest/specs/99-s-diff-side-copy.spec.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installSideSelectionGuard,
  SIDE_CLASS_LEFT,
  SIDE_CLASS_RIGHT,
} from "../../src/lib/sideSelectionGuard";

let body: HTMLDivElement;
let uninstall: () => void;

/** 与 DiffPanel 同一行结构：行号 / 左格 / 箭头列 / 行号 / 右格。 */
function buildBody(): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "diff-body mono";
  const words = ["alpha", "bravo", "charlie"];
  words.forEach((word, i) => {
    const row = document.createElement("div");
    row.className = "diff-row modify";
    row.innerHTML =
      `<span class="diff-gutter">${i + 1}</span>` +
      `<pre class="diff-cell left">left ${word}</pre>` +
      `<span class="diff-merge-center"></span>` +
      `<span class="diff-gutter">${i + 1}</span>` +
      `<pre class="diff-cell right">right ${word}</pre>`;
    el.appendChild(row);
  });
  document.body.appendChild(el);
  return el;
}

/** jsdom 量不出盒子：给守卫要读的那一个元素手工喂几何。 */
function stubBodyRect(el: HTMLElement, width = 800, height = 400): void {
  const rect: DOMRect = {
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  el.getBoundingClientRect = () => rect;
}

function pointerDown(target: Node, clientX: number): void {
  target.dispatchEvent(
    new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX, clientY: 200 })
  );
}

/** 按住主键的指针移动（buttons 低位 = 1）。 */
function pointerMoveHeld(target: Node, clientX: number): void {
  target.dispatchEvent(
    new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX, clientY: 200, buttons: 1 })
  );
}

function sides(el: HTMLElement): { left: boolean; right: boolean } {
  return {
    left: el.classList.contains(SIDE_CLASS_LEFT),
    right: el.classList.contains(SIDE_CLASS_RIGHT),
  };
}

beforeEach(() => {
  body = buildBody();
  stubBodyRect(body);
  uninstall = installSideSelectionGuard(body);
});

afterEach(() => {
  uninstall();
  body.remove();
});

describe("落点在正文格里：按格子分侧（既有行为）", () => {
  it("起手在左格 → 只锁 left", () => {
    pointerDown(body.querySelector(".diff-cell.left") as Node, 100);
    expect(sides(body)).toEqual({ left: true, right: false });
  });

  it("起手在右格 → 只锁 right", () => {
    pointerDown(body.querySelector(".diff-cell.right") as Node, 600);
    expect(sides(body)).toEqual({ left: false, right: true });
  });
});

describe("落点在本 body 内、但不在正文格里：仍必须分到一侧", () => {
  it("从左侧行号槽起手（左半屏）→ 锁 left，不许清空", () => {
    const gutters = body.querySelectorAll<HTMLElement>(".diff-gutter");
    pointerDown(gutters[0], 20);
    expect(sides(body)).toEqual({ left: true, right: false });
  });

  it("从右侧行号槽起手（右半屏）→ 锁 right，不许清空", () => {
    const gutters = body.querySelectorAll<HTMLElement>(".diff-gutter");
    pointerDown(gutters[gutters.length - 1], 700);
    expect(sides(body)).toEqual({ left: false, right: true });
  });

  it("从中间合并箭头列起手 → 分到某一侧即可，不许清空", () => {
    pointerDown(body.querySelector(".diff-merge-center") as Node, 400);
    const s = sides(body);
    expect(s.left || s.right, "落点在 body 内必须分到一侧").toBe(true);
  });
});

describe("落点在本 body 之外 / 卸载：清空与撤监听", () => {
  it("body 外起手 → 清空两侧（不替用户做主）", () => {
    pointerDown(body.querySelector(".diff-cell.left") as Node, 100);
    expect(sides(body).left).toBe(true);
    pointerDown(document.body, 100);
    expect(sides(body)).toEqual({ left: false, right: false });
  });

  it("卸载后监听撤净、类撤净", () => {
    pointerDown(body.querySelector(".diff-cell.left") as Node, 100);
    expect(sides(body).left).toBe(true);
    uninstall();
    expect(sides(body)).toEqual({ left: false, right: false });
    pointerDown(body.querySelector(".diff-cell.left") as Node, 100);
    expect(sides(body)).toEqual({ left: false, right: false });
  });
});

describe("body 外起手、拖进 body：按住移动时补分侧", () => {
  it("body 外起手（清空）→ 拖进左格 → 锁 left", () => {
    pointerDown(document.body, 100);
    pointerMoveHeld(body.querySelector(".diff-cell.left") as Node, 100);
    expect(sides(body)).toEqual({ left: true, right: false });
  });

  it("body 外起手（清空）→ 拖进右行号槽（右半屏）→ 锁 right", () => {
    pointerDown(document.body, 700);
    const gutters = body.querySelectorAll<HTMLElement>(".diff-gutter");
    pointerMoveHeld(gutters[gutters.length - 1], 700);
    expect(sides(body)).toEqual({ left: false, right: true });
  });

  it("未按住主键的移动不补分侧", () => {
    pointerDown(document.body, 100);
    targetMoveNoButton(body.querySelector(".diff-cell.left") as Node);
    expect(sides(body)).toEqual({ left: false, right: false });
  });

  it("已分到侧后，指针移到对侧不偷换侧", () => {
    pointerDown(body.querySelector(".diff-cell.left") as Node, 100);
    expect(sides(body).left).toBe(true);
    pointerMoveHeld(body.querySelector(".diff-cell.right") as Node, 600);
    expect(sides(body)).toEqual({ left: true, right: false });
  });

  function targetMoveNoButton(target: Node): void {
    target.dispatchEvent(
      new MouseEvent("pointermove", { bubbles: true, cancelable: true, clientX: 100, clientY: 200, buttons: 0 })
    );
  }
});

describe("键盘路径兜底：选区起点在左格", () => {
  it("selectionchange 起点落在左格 → 锁 left", () => {
    const sel = document.getSelection();
    if (!sel) throw new Error("jsdom 未提供 selection API");
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(body.querySelector(".diff-cell.left") as Node);
    sel.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    expect(sides(body)).toEqual({ left: true, right: false });
  });
});

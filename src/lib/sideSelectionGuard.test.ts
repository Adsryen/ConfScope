/**
 * @vitest-environment jsdom
 *
 * 串侧守卫的判定层（轮66）。
 *
 * 「另一侧不可选 ⇒ 复制出来只剩一侧」这一段靠引擎实现，jsdom 不解析 styles.css 也不支持
 * user-select，所以那半在真机探针里量（tests/retest）。这里钉死的是我们自己写的判定：
 * 起手落在哪一侧、类怎么翻、离开正文要不要收口——这三条一旦分叉，用户看到的就又是串侧。
 */
import { afterEach, describe, expect, it } from "vitest";
import { SIDE_CLASS_LEFT, SIDE_CLASS_RIGHT, applyGuardedSide, installSideSelectionGuard, sideOfNode } from "./sideSelectionGuard";

const ROWS = `
<div class="diff-body mono">
  <div class="diff-row context" data-row-index="0">
    <span class="diff-gutter">1</span>
    <pre class="diff-cell left">alpha-left-one</pre>
    <span class="diff-merge-center"><button type="button" aria-label="merge">→</button></span>
    <span class="diff-gutter">1</span>
    <pre class="diff-cell right">bravo-right-one</pre>
  </div>
  <div class="diff-row context" data-row-index="1">
    <span class="diff-gutter">2</span>
    <pre class="diff-cell left">charlie-left-two</pre>
    <span class="diff-merge-center"><button type="button" aria-label="merge">→</button></span>
    <span class="diff-gutter">2</span>
    <pre class="diff-cell right">delta-right-two</pre>
  </div>
</div>`;

function mount() {
  document.body.innerHTML = ROWS;
  return document.querySelector<HTMLElement>(".diff-body")!;
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((off) => off());
  document.body.innerHTML = "";
});

function firstText(el: Element | null): Text | null {
  return el ? (el.firstChild as Text) : null;
}

describe("sideOfNode：起手在哪一格", () => {
  it("左右两格各自认侧，跨行号槽与合并箭头都不算", () => {
    const body = mount();
    expect(sideOfNode(firstText(body.querySelector(".diff-cell.left")))).toBe("left");
    expect(sideOfNode(firstText(body.querySelector(".diff-cell.right")))).toBe("right");
    expect(sideOfNode(body.querySelector(".diff-gutter"))).toBeNull();
    expect(sideOfNode(body.querySelector(".diff-merge-center button"))).toBeNull();
    expect(sideOfNode(body)).toBeNull();
    expect(sideOfNode(null)).toBeNull();
  });

  it("格子里的高亮子节点也认（命中词是 <span class=search-hit> 里的文本节点）", () => {
    const body = mount();
    const cell = body.querySelector<HTMLElement>(".diff-cell.left")!;
    cell.innerHTML = `prefix<span class="search-hit">word</span>suffix`;
    expect(sideOfNode(cell.querySelector(".search-hit")!.firstChild)).toBe("left");
  });
});

describe("applyGuardedSide：两个类互斥，null 收口", () => {
  it("起手左 ⇒ 只有 side-select-left", () => {
    const body = mount();
    applyGuardedSide(body, "left");
    expect(body.classList.contains(SIDE_CLASS_LEFT)).toBe(true);
    expect(body.classList.contains(SIDE_CLASS_RIGHT)).toBe(false);
  });

  it("起手右 ⇒ 翻面，不残留上一侧", () => {
    const body = mount();
    applyGuardedSide(body, "left");
    applyGuardedSide(body, "right");
    expect(body.classList.contains(SIDE_CLASS_LEFT)).toBe(false);
    expect(body.classList.contains(SIDE_CLASS_RIGHT)).toBe(true);
  });

  it("null ⇒ 两个类都清掉", () => {
    const body = mount();
    applyGuardedSide(body, "left");
    applyGuardedSide(body, null);
    expect(body.className).toBe("diff-body mono");
  });
});

describe("installSideSelectionGuard：监听时序与卸载", () => {
  const down = (target: Element) => target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));

  it("pointerdown 在左格 ⇒ 同帧就把类写上（不等 React state）", () => {
    const body = mount();
    cleanup.push(installSideSelectionGuard(body));
    down(body.querySelector(".diff-cell.left")!);
    expect(body.classList.contains(SIDE_CLASS_LEFT)).toBe(true);
    down(body.querySelector(".diff-cell.right")!);
    expect(body.classList.contains(SIDE_CLASS_RIGHT)).toBe(true);
    expect(body.classList.contains(SIDE_CLASS_LEFT)).toBe(false);
  });

  it("pointerdown 落在正文外 ⇒ 收口，不替用户做主", () => {
    const body = mount();
    cleanup.push(installSideSelectionGuard(body));
    down(body.querySelector(".diff-cell.left")!);
    expect(body.classList.contains(SIDE_CLASS_LEFT)).toBe(true);
    down(document.body);
    expect(body.className).toBe("diff-body mono");
  });

  it("卸载后监听器与类都清干净（两块面板同时在页面上也不串）", () => {
    const first = mount();
    const second = document.createElement("div");
    second.className = "diff-body mono";
    second.innerHTML = `<pre class="diff-cell left">other-panel</pre>`;
    document.body.appendChild(second);
    const off = installSideSelectionGuard(first);
    cleanup.push(installSideSelectionGuard(second));
    down(first.querySelector(".diff-cell.left")!);
    expect(first.classList.contains(SIDE_CLASS_LEFT)).toBe(true);
    off();
    expect(first.classList.contains(SIDE_CLASS_LEFT)).toBe(false);
    down(first.querySelector(".diff-cell.left")!);
    expect(first.classList.contains(SIDE_CLASS_LEFT)).toBe(false);
  });
});

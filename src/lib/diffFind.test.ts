/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { highlightLine } from "./highlight";
import { CURRENT_HIT_CLASS, markHighlightedHtml, currentHitSelector } from "./codeLines";
import {
  baseIndexForSide,
  currentDiffGroup,
  EMPTY_DIFF_FIND,
  findDiffHits,
  marksForRowSide,
  rowSideKey,
  toLineHits,
  type DiffFindRow,
} from "./diffFind";

/** 造一行：rowIndex + 左右两格正文。 */
function row(rowIndex: number, left: string | null, right: string | null): DiffFindRow {
  return { rowIndex, left, right };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("findDiffHits：行 → 侧 → 列的编号顺序", () => {
  it("同一行左右两格都命中时只算一个步进单位，编号左格在前", () => {
    // 等行两格逐字相同（并排视图的真实形状）
    const result = findDiffHits([row(0, "serverPort: 8080", "serverPort: 8080")], "8080");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].rowIndex).toBe(0);
    expect(result.marks.map((mark) => [mark.index, mark.side])).toEqual([
      [0, "left"],
      [1, "right"],
    ]);
  });

  it("跨行按文档序编号，组内编号连续（baseIndexForSide 的前提）", () => {
    const result = findDiffHits([row(0, "a", "x b"), row(3, "b b", null), row(4, "b", "b b")], "b");
    // 第 0 行只有右格命中、第 3 行只有左格命中、第 4 行两格都命中：编号仍严格 0..5 连号
    expect(result.marks.map((mark) => [mark.index, mark.rowIndex, mark.side, mark.column])).toEqual([
      [0, 0, "right", 2],
      [1, 3, "left", 0],
      [2, 3, "left", 2],
      [3, 4, "left", 0],
      [4, 4, "right", 0],
      [5, 4, "right", 2],
    ]);
    expect(result.groups.map((group) => group.markIndexes)).toEqual([[0], [1, 2], [3, 4, 5]]);
    for (const group of result.groups) {
      const indexes = group.markIndexes;
      expect(indexes).toEqual(indexes.map((_, i) => indexes[0] + i));
    }
  });

  it("同格内多处按列升序", () => {
    const result = findDiffHits([row(0, "b b b", null)], "b");
    expect(result.marks.map((mark) => [mark.index, mark.column])).toEqual([
      [0, 0],
      [1, 2],
      [2, 4],
    ]);
  });

  it("空词 / 全空格 / 没有行时返回同一份常量引用：memo 不该因为新对象每次重算", () => {
    const rows = [row(0, "abc", "abc")];
    expect(findDiffHits(rows, "")).toBe(EMPTY_DIFF_FIND);
    expect(findDiffHits(rows, "   ")).toBe(EMPTY_DIFF_FIND);
    expect(findDiffHits([], "abc")).toBe(EMPTY_DIFF_FIND);
    expect(EMPTY_DIFF_FIND.groups).toEqual([]);
    expect(EMPTY_DIFF_FIND.capped).toBe(false);
  });

  it("只扫传进来的行集：onlyChanges 隐藏的行不许留在编号里", () => {
    const all = [row(0, "x y", "x y"), row(1, "y", "y"), row(2, "z", "z")];
    const onlyChanges = [row(0, "x y", "x y"), row(2, "z", "z")];
    const full = findDiffHits(all, "y");
    const visible = findDiffHits(onlyChanges, "y");
    expect(full.marks).toHaveLength(4);
    // 隐藏的第 1 行不在编号里 ⇒ 「第 N 处」永远能在 DOM 里找到对应的 <mark>
    expect(visible.marks.map((mark) => mark.rowIndex)).toEqual([0, 0]);
    expect(visible.groups).toHaveLength(1);
  });

  it("null 格（另一侧没有这一行）跳过，不占编号", () => {
    const result = findDiffHits([row(0, null, "solo"), row(1, "solo", null)], "solo");
    expect(result.marks.map((mark) => [mark.rowIndex, mark.side])).toEqual([
      [0, "right"],
      [1, "left"],
    ]);
  });

  it("命中行按侧记录：行号变红只报给真的有命中的那一侧", () => {
    const result = findDiffHits([row(0, "hit", "clean"), row(1, "clean", "hit")], "hit");
    expect([...result.hitRows.left]).toEqual([0]);
    expect([...result.hitRows.right]).toEqual([1]);
  });

  it("大小写 / 全词只经 textMatch 一份口径", () => {
    const rows = [row(0, "ServerPort serverPortX", null)];
    expect(findDiffHits(rows, "serverport").marks).toHaveLength(2);
    expect(findDiffHits(rows, "serverport", { caseSensitive: true }).marks).toHaveLength(0);
    expect(findDiffHits(rows, "serverPort", { wholeWord: true }).marks).toHaveLength(1);
  });
});

describe("findDiffHits：触顶时宁可少标，不可重号", () => {
  it("停在某格中间时，那一行的组只收已分配出去的编号", () => {
    const rows = [row(0, "a a a a", "a a"), row(1, "a", "a")];
    const result = findDiffHits(rows, "a", {}, 3);
    expect(result.marks).toHaveLength(3);
    expect(result.capped).toBe(true);
    expect(result.groups[0].markIndexes).toEqual([0, 1, 2]);
    expect(result.groups.map((group) => group.rowIndex)).toEqual([0]);
    // 编号严格连续且从 0 起，越界的第 4 处根本没被造出来
    expect(result.marks.map((mark) => mark.index)).toEqual([0, 1, 2]);
  });

  it("未触顶时 capped 为假，max 槽该说真话", () => {
    const result = findDiffHits([row(0, "a", "a")], "a", {}, 4);
    expect(result.capped).toBe(false);
    expect(result.groups).toHaveLength(1);
  });

  it("预算停在某一格里时，剩下的行整批不进入步进序列", () => {
    const rows = [row(0, "a a", "a a"), row(1, "a a", "a a")];
    const result = findDiffHits(rows, "a", {}, 4);
    expect(result.marks).toHaveLength(4);
    // 4 处标红挤在第 0 行的两格里 ⇒ 能导航的只有 1 步，第 1 行连号都没拿到
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].rowIndex).toBe(0);
    expect(marksForRowSide(result, 1, "left")).toHaveLength(0);
    expect(result.capped).toBe(true);
  });
});

describe("查表与换算", () => {
  it("rowSideKey 是 `${rowIndex}:${side}`", () => {
    expect(rowSideKey(3, "left")).toBe("3:left");
  });

  it("某格没有命中时返回同一个空数组常量：调用方可以直接喂给 memo", () => {
    const result = findDiffHits([row(0, "abc", "abc")], "abc");
    const first = marksForRowSide(result, 9, "left");
    expect(first).toHaveLength(0);
    expect(marksForRowSide(result, 9, "right")).toBe(first);
  });

  it("toLineHits 的 offset 就是行内列号：每格单独喂一份 HTML", () => {
    const result = findDiffHits([row(0, "x ab ab", null)], "ab");
    expect(toLineHits(marksForRowSide(result, 0, "left"))).toEqual([
      { line: 0, column: 2, offset: 2, length: 2 },
      { line: 0, column: 5, offset: 5, length: 2 },
    ]);
  });

  it("baseIndexForSide 给本格第一处的全篇编号", () => {
    const result = findDiffHits([row(0, "no", "no"), row(1, "no", "no")], "no");
    expect(baseIndexForSide(marksForRowSide(result, 0, "left"))).toBe(0);
    expect(baseIndexForSide(marksForRowSide(result, 0, "right"))).toBe(1);
    expect(baseIndexForSide(marksForRowSide(result, 1, "left"))).toBe(2);
    expect(baseIndexForSide([])).toBe(0);
  });

  it("currentDiffGroup 把越界的旧序号夹回来：换词后命中变少不该指向不存在的那一处", () => {
    const result = findDiffHits([row(0, "a", "a"), row(1, "a", "a")], "a");
    expect(currentDiffGroup(result, 5)?.rowIndex).toBe(1);
    expect(currentDiffGroup(result, -3)?.rowIndex).toBe(0);
    expect(currentDiffGroup(result, 1)?.rowIndex).toBe(1);
    expect(currentDiffGroup(EMPTY_DIFF_FIND, 0)).toBeNull();
  });
});

describe("与 markHighlightedHtml 的端到端契约：偏移口径必须自洽", () => {
  /** 把一格的 HTML 挂进 DOM，返回解码后的正文与 data-hit 集合。 */
  function mount(html: string) {
    const pre = document.createElement("pre");
    pre.innerHTML = html;
    document.body.appendChild(pre);
    const marks = Array.from(pre.querySelectorAll<HTMLElement>("mark[data-hit]")).map((mark) => mark.dataset.hit);
    return { text: pre.textContent ?? "", marks };
  }

  it("含 & 与 < 的行标红后 textContent 仍逐字等于原文，列号对得上命中的位置", () => {
    const text = 'a <b> & "amp" b';
    const result = findDiffHits([row(0, text, null)], "b");
    const html = markHighlightedHtml(highlightLine(text, "TEXT"), toLineHits(marksForRowSide(result, 0, "left")), baseIndexForSide(marksForRowSide(result, 0, "left")));
    const mounted = mount(html);
    expect(mounted.text).toBe(text);
    expect(mounted.marks).toEqual(["0", "1"]);
    // 编号指向的字符就是命中本身（不是转义撑出来的偏移）
    for (const mark of result.marks) {
      expect(text.slice(mark.column, mark.column + mark.length)).toBe("b");
    }
  });

  it("左右两格各自的 data-hit 不重号：currentHitSelector 能选中这一行这一格", () => {
    // 每格两处：并排视图里同一行左右各标红两个词是常态（等行 + 外部搜索词）
    const rows = [row(0, "k k", "k"), row(1, "k", "k k")];
    const result = findDiffHits(rows, "k");
    expect(result.marks).toHaveLength(6);
    const all: string[] = [];
    for (const entry of rows) {
      for (const side of ["left", "right"] as const) {
        const text = side === "left" ? entry.left : entry.right;
        if (text == null) continue;
        const marks = marksForRowSide(result, entry.rowIndex, side);
        const html = markHighlightedHtml(highlightLine(text, "TEXT"), toLineHits(marks), baseIndexForSide(marks));
        for (const attr of html.match(/data-hit="(\d+)"/g) ?? []) all.push(attr.replace(/\D/g, ""));
      }
    }
    expect(all).toEqual(["0", "1", "2", "3", "4", "5"]);
  });

  it("当前命中类由视图在提交后切换：编号进 HTML，类不进 HTML", () => {
    const result = findDiffHits([row(0, "k", null)], "k");
    const marks = marksForRowSide(result, 0, "left");
    const html = markHighlightedHtml(highlightLine("k", "TEXT"), toLineHits(marks), baseIndexForSide(marks));
    expect(html).not.toContain(CURRENT_HIT_CLASS);
    expect(html).not.toContain(currentHitSelector(0));
    const pre = document.createElement("pre");
    pre.innerHTML = html;
    const mark = pre.querySelector<HTMLElement>("mark");
    expect(mark?.dataset.hit).toBe("0");
  });
});

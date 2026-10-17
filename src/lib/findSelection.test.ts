/**
 * @vitest-environment jsdom
 *
 * 查找栏「选中即查找」的初值口径（轮26 F-3）。
 * 纯函数部分（清洗 / 优先级）和两个读取器分开钉：读取器里藏着"不许劫持宿主输入框"
 * 这道闸，它在真浏览器上的行为（Chromium 在 `<input>` 里选中时 rangeCount 0 但
 * toString 仍带回文字）和只判 toString 的写法完全等价于一个真 bug。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_FIND_TERM_FROM_SELECTION,
  pickFindTermOnOpen,
  selectionTextWithin,
  selectionToFindTerm,
  textareaSelectionText,
} from "./findSelection";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("selectionToFindTerm：选区原文 → 可用查找词", () => {
  it("跨行选区只取首行（后面的行拼进去必然 0 命中）", () => {
    expect(selectionToFindTerm("server.port=8080\nname = x")).toBe("server.port=8080");
  });

  it("行首是空白段时跳过它：从行尾起手选中，第一段常常只剩空格或换行", () => {
    expect(selectionToFindTerm("\n   \n  timeout=30  \nnext")).toBe("timeout=30");
  });

  it("三种换行都算：正文来自外部配置文件，不保证已归一成 \\n", () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      expect(selectionToFindTerm(`first${eol}second`), `EOL=${JSON.stringify(eol)}`).toBe("first");
    }
  });

  it("超长选区截断到上限，而不是干脆不用", () => {
    const long = "x".repeat(MAX_FIND_TERM_FROM_SELECTION + 500);
    expect(selectionToFindTerm(long)).toBe("x".repeat(MAX_FIND_TERM_FROM_SELECTION));
  });

  it("整段都是空白 / 空值 → 空串，调用方据此退回原有口径", () => {
    expect(selectionToFindTerm("   \n\t  \n")).toBe("");
    expect(selectionToFindTerm("")).toBe("");
    expect(selectionToFindTerm(null)).toBe("");
    expect(selectionToFindTerm(undefined)).toBe("");
  });
});

describe("pickFindTermOnOpen：初值优先级 = 选区 > 栏内旧词 > 外部搜索词", () => {
  it("有选区时选区赢过旧词——用户特意选中再按 Ctrl+F，要的就是搜它", () => {
    expect(pickFindTermOnOpen({ previous: "old", selectionRaw: "picked", external: "ext" })).toBe("picked");
  });

  it("没选区时沿用栏内旧词：重复按 Ctrl+F 不该把刚打的词清掉", () => {
    expect(pickFindTermOnOpen({ previous: "old", selectionRaw: "   \n ", external: "ext" })).toBe("old");
  });

  it("既没选区也没旧词才落到外部内容搜索词", () => {
    expect(pickFindTermOnOpen({ external: "ext" })).toBe("ext");
    expect(pickFindTermOnOpen({ previous: "", selectionRaw: "", external: "ext" })).toBe("ext");
  });

  it("三个来源都不适用时返回空串（不许凭空造词）", () => {
    expect(pickFindTermOnOpen({})).toBe("");
  });
});

describe("selectionTextWithin：只认落在 scope 内的选区", () => {
  /** 造 DOM：scope 里一句正文，scope 外一句"宿主搜索框"式的文字。 */
  function mount() {
    document.body.innerHTML = `<pre id="scope">alpha beta gamma</pre><div id="outside">delta epsilon</div>`;
    return { scope: document.getElementById("scope")!, outside: document.getElementById("outside")! };
  }

  function selectFrom(node: Node, start: number, end: number) {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    return sel;
  }

  it("scope 内的真选区读回原文（jsdom 支持 Range，不必 stub）", () => {
    const { scope } = mount();
    const text = scope.firstChild!;
    selectFrom(text, 6, 10); // "beta"
    expect(selectionTextWithin(scope)).toBe("beta");
  });

  it("选区落在 scope 外一律不算：不许把宿主输入框/别的文件视图的选中词抢过来", () => {
    const { scope, outside } = mount();
    // 前置条件：这份选区在 toString 层面完全"像"一个正文选区，只靠 scope 归属才能挡掉
    selectFrom(outside.firstChild!, 0, 5);
    expect(window.getSelection()?.toString()).toBe("delta");
    expect(selectionTextWithin(scope)).toBe("");
  });

  it("半截跨出 scope 的选区也不算（起点在内、终点在外）", () => {
    const { scope, outside } = mount();
    const range = document.createRange();
    range.setStart(scope.firstChild!, 6);
    range.setEnd(outside.firstChild!, 5);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(selectionTextWithin(scope)).toBe("");
  });

  it("折叠光标（rangeCount 1 但 isCollapsed）返回空串", () => {
    const { scope } = mount();
    const sel = selectFrom(scope.firstChild!, 3, 3);
    expect(sel.rangeCount).toBe(1);
    expect(sel.isCollapsed).toBe(true);
    expect(selectionTextWithin(scope)).toBe("");
  });

  it("没有 scope / 没有 window 时安全返回空串", () => {
    expect(selectionTextWithin(null)).toBe("");
    expect(selectionTextWithin(undefined)).toBe("");
  });
});

describe("textareaSelectionText：编辑态的选中内容不走 window.getSelection", () => {
  function mountTextarea(value: string) {
    const ta = document.createElement("textarea");
    ta.value = value;
    document.body.appendChild(ta);
    return ta;
  }

  it("按 selectionStart/End 切出选中文本", () => {
    const ta = mountTextarea("server.port=8080");
    ta.setSelectionRange(7, 11); // "port"
    expect(textareaSelectionText(ta)).toBe("port");
  });

  it("折叠光标返回空串", () => {
    const ta = mountTextarea("server.port=8080");
    ta.setSelectionRange(3, 3);
    expect(textareaSelectionText(ta)).toBe("");
  });

  it("textarea 之外（input）也读：共用同一个 selectionStart/End 口径", () => {
    const input = document.createElement("input");
    input.value = "host search box";
    document.body.appendChild(input);
    input.setSelectionRange(0, 4);
    expect(textareaSelectionText(input)).toBe("host");
  });

  it("传空返回空串", () => {
    expect(textareaSelectionText(null)).toBe("");
    expect(textareaSelectionText(undefined)).toBe("");
  });
});

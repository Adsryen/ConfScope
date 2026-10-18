/**
 * @vitest-environment jsdom
 */
import { StrictMode } from "react";
import { fireEvent, render, screen, settleFindInputCommit, waitFor } from "../test/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIND_INPUT_DEFER_MIN_LINES } from "../lib/findInput";
import { I18nProvider } from "../i18n";
import CodeView from "./CodeView";
import { clearViewState, writeViewState } from "../lib/viewState";
import { FIND_BAR_FALLBACK_HEIGHT, FIND_BAR_GAP, FIND_BAR_TOP, HIT_REVEAL_MARGIN } from "../lib/codeScroll";
import { isMarkVisible, stubCodeHorizontalLayout, stubScrollLeft } from "../test/codeLayout";
import { MAX_CODE_HITS } from "../lib/codeLines";
import type { Format } from "../lib/format";

function renderView(
  code: string,
  format: Format = "TEXT",
  props: { searchTerm?: string; showMinimap?: boolean; enableFind?: boolean; active?: boolean } = {}
) {
  localStorage.setItem("locale", "zh-CN");
  return render(
    <I18nProvider>
      <CodeView code={code} format={format} {...props} />
    </I18nProvider>
  );
}

const MULTI = 'server.port=8080\nname = "a<b&c>"\nqps: 10000\nport = 8081\n';

/**
 * 共享假几何（R74 起，轮29 复用）。
 *
 * jsdom 没有布局：clientHeight / scrollHeight 恒为 0，`scrollLineIntoView` 的 clamp 结果也就恒为 0，
 * 「跳没跳」和「跳歪了」在这种桩下分不开。所以先把高度撑出来，再让 scrollTop 可读写。
 * 传 `writes` 时顺手记一次赋值次数——轮29 F-17 要钉的正是「按一次 Enter 到底滚了几回」。
 */
const VIEWPORT_H = 100;
const CONTENT_H = 600;

function stubGeometry(pre: HTMLElement, writes?: { count: number }) {
  const offsets = { top: 0, left: 0 };
  Object.defineProperty(pre, "scrollTop", {
    configurable: true,
    get: () => offsets.top,
    set: (value: number) => {
      offsets.top = value;
      if (writes) writes.count += 1;
    },
  });
  Object.defineProperty(pre, "scrollLeft", {
    configurable: true,
    get: () => offsets.left,
    set: (value: number) => {
      offsets.left = value;
    },
  });
  Object.defineProperty(pre, "clientHeight", { configurable: true, get: () => VIEWPORT_H });
  Object.defineProperty(pre, "scrollHeight", { configurable: true, get: () => CONTENT_H });
  return offsets;
}

/**
 * 行号槽里第 N 行的 top 就是「行 i 的 top = PAD_TOP + i * ROW_H」这条公式的另一个出口，
 * 拿它当期望值就不用把 CodeView 的几何常量抄第二份（抄第二份等于埋一条会随波次腐烂的假断言）。
 */
/**
 * 24 行正文，needle（timeout）分别落在第 12 行与第 21 行（0 基 11 / 20）——刻意离文件开头足够远，
 * 「停在开头」和「跳到命中行」在断言里才分得开。R74 与轮29 F-17/F-18 共用这一份。
 */
const DEEP_LINES = Array.from({ length: 24 }, (_, i) => (i === 11 ? "timeout = 3000" : i === 20 ? "timeout = 5000" : `key${i} = ${i}`));
const DEEP = `${DEEP_LINES.join("\n")}\n`;

function expectedTopFor(container: HTMLElement, lineOneBased: number) {
  const row = [...container.querySelectorAll<HTMLElement>(".code-ln")].find((el) => el.textContent === String(lineOneBased));
  expect(row, `行号槽里没有第 ${lineOneBased} 行，视口范围算错了`).toBeTruthy();
  return parseFloat(row!.style.top) - VIEWPORT_H / 2;
}

describe("CodeView 行号 / 命中 / 标红", () => {
  afterEach(() => {
    // jsdom 无真实布局：确保用例互不干扰
  });

  it("渲染行号，且行号绝不混入 .code-area 的文本", () => {
    const { container } = renderView(MULTI, "Properties");
    const gutter = container.querySelector(".code-gutter");
    const numbers = gutter ? [...gutter.querySelectorAll(".code-ln")].map((n) => n.textContent) : [];
    expect(numbers[0]).toBe("1");
    expect(numbers).toContain("4");

    const area = container.querySelector(".code-area") as HTMLElement;
    expect(area.textContent).toBe(MULTI); // 行号 / 命中底色都在 .code-area 之外
  });

  it("内容搜索：命中词标红、命中行高亮、文本内容逐字不变", () => {
    const { container } = renderView(MULTI, "Properties", { searchTerm: "8080" });
    const marks = container.querySelectorAll(".code-area mark.search-hit");
    expect(marks.length).toBeGreaterThan(0);
    const hitLines = container.querySelectorAll(".code-lines .code-line.is-hit");
    expect(hitLines.length).toBeGreaterThan(0);
    const area = container.querySelector(".code-area") as HTMLElement;
    expect(area.textContent).toBe(MULTI);
    expect(container.innerHTML).not.toContain("&amp;amp;");
  });

  it("跨语法 token 的搜索词也能标红（properties 里被拆分的 key=value）", () => {
    const { container } = renderView(MULTI, "Properties", { searchTerm: "port=8080" });
    // 命中跨越 hljs 拆分的 token：整文档匹配仍完整，只是被切成相邻的多个 <mark>，
    // 拼接其文本应还原出完整搜索词（旧实现里这类跨 token 命中会被整体漏掉）。
    const marks = [...container.querySelectorAll(".code-area mark.search-hit")];
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.map((m) => m.textContent).join("")).toBe("port=8080");
  });

  it("无搜索词时不产生命中结构", () => {
    const { container } = renderView(MULTI, "Properties");
    expect(container.querySelector(".code-area mark.search-hit")).toBeNull();
    expect(container.querySelector(".code-lines .code-line.is-hit")).toBeNull();
  });
});

describe("CodeView 缩略图", () => {
  it("默认渲染缩略图与 canvas；showMinimap=false 时隐藏", () => {
    const { container } = renderView(MULTI);
    expect(container.querySelector(".code-minimap")).not.toBeNull();
    expect(container.querySelector(".code-minimap canvas")).not.toBeNull();

    const { container: c2 } = renderView(MULTI, "TEXT", { showMinimap: false });
    expect(c2.querySelector(".code-minimap")).toBeNull();
  });

  it("有可见布局尺寸后显示视口框", async () => {
    const { container } = renderView(MULTI);
    const pre = container.querySelector(".code-area") as HTMLElement;
    Object.defineProperty(pre, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(pre, "scrollHeight", { configurable: true, get: () => 400 });
    fireEvent.scroll(pre);
    await waitFor(() => {
      const vp = container.querySelector(".code-minimap-viewport") as HTMLElement;
      expect(vp).not.toBeNull();
      expect(vp.style.height).toBe("25%");
    });
  });

  it("空文件不渲染缩略图", () => {
    const { container } = renderView("");
    expect(container.querySelector(".code-minimap")).toBeNull();
  });

  /** jsdom 里 scrollHeight / clientHeight 恒 0，几何只能自己装（与「有可见布局尺寸后显示视口框」同一手法）。 */
  function setGeometry(pre: HTMLElement, clientHeight: number, scrollHeight: number) {
    Object.defineProperty(pre, "clientHeight", { configurable: true, get: () => clientHeight });
    Object.defineProperty(pre, "scrollHeight", { configurable: true, get: () => scrollHeight });
    fireEvent.scroll(pre);
  }

  const padVars = (pre: HTMLElement) => [pre.style.getPropertyValue("--code-pad-right"), pre.style.getPropertyValue("--code-find-right")];

  // 轮28 F-13：不满一屏时 jumpFromPointer 算出的 scrollTop 恒被夹到 0——
  // 一个「看得见、点不动、还占着右侧留白」的死控件，索性不出现。
  it("量到「不满一屏」收起缩略图，但右侧留白按设置继续预留（防自激振荡）", async () => {
    const { container } = renderView(MULTI);
    const area = container.querySelector(".code-area") as HTMLElement;

    setGeometry(area, 100, 400);
    await waitFor(() => expect(container.querySelector(".code-minimap")).not.toBeNull());
    const shown = padVars(area);

    setGeometry(area, 400, 400);
    await waitFor(() => expect(container.querySelector(".code-minimap")).toBeNull());
    expect(padVars(area), "留白跟着缩略图显隐变 ⇒ 正文宽变 ⇒ 高度又变 ⇒ 抖动").toEqual(shown);

    // 再变回可滚：缩略图得重新出现（ResizeObserver 的依赖必须跟着显隐位，否则重新挂载后没人量它）
    setGeometry(area, 100, 400);
    await waitFor(() => expect(container.querySelector(".code-minimap")).not.toBeNull());
  });

  it("阈值是「多出一行以上」：差 1px 算不能滚，差 2px 算能滚", async () => {
    const { container } = renderView(MULTI);
    const area = container.querySelector(".code-area") as HTMLElement;
    setGeometry(area, 400, 401);
    await waitFor(() => expect(container.querySelector(".code-minimap")).toBeNull());
    setGeometry(area, 400, 402);
    await waitFor(() => expect(container.querySelector(".code-minimap")).not.toBeNull());
  });

  it("量不到几何时放行：首帧不该闪没", () => {
    const { container } = renderView(MULTI);
    expect(container.querySelector(".code-minimap")).not.toBeNull();
  });

  it("showMinimap=false 时留白退回窄值（与显隐门控是两条独立口径）", () => {
    const { container } = renderView(MULTI, "TEXT", { showMinimap: false });
    const area = container.querySelector(".code-area") as HTMLElement;
    expect(container.querySelector(".code-minimap")).toBeNull();
    expect(padVars(area)).toEqual(["68px", "16px"]);
  });
});

describe("CodeView Ctrl+F 查找", () => {
  it("Ctrl+F 打开查找栏并聚焦输入框", async () => {
    const { container } = renderView(MULTI);
    expect(container.querySelector(".code-find-input")).toBeNull();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    await waitFor(() => {
      expect(container.querySelector(".code-find-input")).not.toBeNull();
    });
  });

  it("输入关键词后统计命中并可跳到当前命中", async () => {
    const { container } = renderView(MULTI, "Properties", { searchTerm: "8080" });
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "port" } });
    const count = container.querySelector(".code-find-count") as HTMLElement;
    expect(count.textContent).toContain("/2"); // server.port / port = 8081 两行各含一次 port

    // 当前命中被特殊标记
    expect(container.querySelector(".code-area mark.search-hit-current")).not.toBeNull();

    fireEvent.keyDown(input, { key: "Enter" }); // 下一处
    expect(container.querySelector(".code-area mark.search-hit-current")).not.toBeNull();

    // 命中行高亮里应有“当前”行
    expect(container.querySelector(".code-lines .code-line.is-current")).not.toBeNull();
  });

  it("Esc 关闭查找栏", async () => {
    const { container } = renderView(MULTI);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => {
      expect(container.querySelector(".code-find-input")).toBeNull();
    });
  });

  it("焦点在其它输入框时 Ctrl+F 不被代码视图劫持", () => {
    localStorage.setItem("locale", "zh-CN");
    const { container } = render(
      <I18nProvider>
        <input data-testid="external" />
        <CodeView code={MULTI} format="TEXT" />
      </I18nProvider>
    );
    const external = screen.getByTestId("external") as HTMLInputElement;
    external.focus(); // 真正移动 activeElement（fireEvent.focus 不会）
    fireEvent.keyDown(external, { key: "f", ctrlKey: true });
    expect(container.querySelector(".code-find-input")).toBeNull();
  });

  it("active=false（宿主页面被保活隐藏）时不劫持全局 Ctrl+F", () => {
    const { container } = renderView(MULTI, "TEXT", { active: false });
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(container.querySelector(".code-find-input")).toBeNull();
  });

  it("enableFind=false 时无查找入口且不响应 Ctrl+F", () => {
    const { container } = renderView(MULTI, "TEXT", { enableFind: false });
    expect(container.querySelector(".code-find-open")).toBeNull();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(container.querySelector(".code-find-input")).toBeNull();
  });
});

describe("CodeView 换内容滚动重置（R9）", () => {
  /** jsdom 没有真实布局，scrollTop/scrollLeft 恒为 0；挂可读写的实现才能断言"被重置"。 */
  function stubScrollOffsets(pre: HTMLElement) {
    const offsets = { top: 0, left: 0 };
    Object.defineProperty(pre, "scrollTop", {
      configurable: true,
      get: () => offsets.top,
      set: (value: number) => {
        offsets.top = value;
      },
    });
    Object.defineProperty(pre, "scrollLeft", {
      configurable: true,
      get: () => offsets.left,
      set: (value: number) => {
        offsets.left = value;
      },
    });
    return offsets;
  }

  function renderKeyed(code: string, contentKey?: string) {
    localStorage.setItem("locale", "zh-CN");
    return render(
      <I18nProvider>
        <CodeView code={code} format="TEXT" contentKey={contentKey} />
      </I18nProvider>
    );
  }

  it("正文变化时把纵向与横向偏移归零", () => {
    const { container, rerender } = renderKeyed(MULTI);
    const offsets = stubScrollOffsets(container.querySelector(".code-area") as HTMLElement);
    offsets.top = 120;
    offsets.left = 40;

    rerender(
      <I18nProvider>
        <CodeView code="other=1\n" format="TEXT" />
      </I18nProvider>
    );

    expect(offsets.top).toBe(0);
    expect(offsets.left).toBe(0);
  });

  it("正文逐字相同但版本不同（contentKey 变）同样归零", () => {
    const { container, rerender } = renderKeyed(MULTI, "public::DEFAULT_GROUP::app.json::v1");
    const offsets = stubScrollOffsets(container.querySelector(".code-area") as HTMLElement);
    offsets.top = 120;

    rerender(
      <I18nProvider>
        <CodeView code={MULTI} format="TEXT" contentKey="public::DEFAULT_GROUP::app.json::v2" />
      </I18nProvider>
    );

    expect(offsets.top).toBe(0);
  });

  it("同一内容重复渲染（如搜索词变化）不误触滚动重置", () => {
    const { container, rerender } = renderKeyed(MULTI, "k1");
    const offsets = stubScrollOffsets(container.querySelector(".code-area") as HTMLElement);
    offsets.top = 120;

    rerender(
      <I18nProvider>
        <CodeView code={MULTI} format="TEXT" contentKey="k1" searchTerm="8080" />
      </I18nProvider>
    );

    expect(offsets.top).toBe(120);
  });
});

describe("CodeView 输入法组合态（R11）", () => {
  it("查找栏的组合态 Enter 不跳命中、Esc 不关栏，上屏后的回车照常跳转", async () => {
    const { container } = renderView(MULTI, "Properties", { searchTerm: "port" });
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    const currentBefore = container.querySelector(".code-area mark.search-hit-current");
    expect(currentBefore).not.toBeNull();

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(container.querySelector(".code-area mark.search-hit-current")).toBe(currentBefore);

    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(container.querySelector(".code-find-input")).not.toBeNull();

    // 负控：非组合态回车仍然跳到下一个命中
    fireEvent.keyDown(input, { key: "Enter" });
    expect(container.querySelector(".code-area mark.search-hit-current")).not.toBe(currentBefore);
  });

  it("组合态期间 Ctrl+F 不被代码视图接管", () => {
    const { container } = renderView(MULTI);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true, isComposing: true });

    expect(container.querySelector(".code-find-input")).toBeNull();
  });
});

describe("CodeView 内容搜索定位（R74）", () => {
  function view(props: { code: string; searchTerm?: string; contentKey?: string }) {
    localStorage.setItem("locale", "zh-CN");
    return (
      <I18nProvider>
        <CodeView format="TEXT" {...props} />
      </I18nProvider>
    );
  }

  it("内容搜索点开文件：首个命中落在视口中间，不再停在文件开头", () => {
    const { container, rerender } = render(view({ code: MULTI }));
    const offsets = stubGeometry(container.querySelector(".code-area") as HTMLElement);
    offsets.top = 300; // 上一份文件里用户自己滚到的位置

    rerender(view({ code: DEEP, searchTerm: "timeout", contentKey: "public::DEFAULT_GROUP::app.properties::v1" }));

    // 先钉用户视角的事实：被标红的那一行有没有进渲染窗口。停在开头时窗口只有前几行，压根画不到它。
    expect(
      [...container.querySelectorAll(".code-ln")].some((el) => el.textContent === "12"),
      "首个命中行根本没渲染出来：视图还停在文件开头"
    ).toBe(true);
    expect(offsets.top).toBe(expectedTopFor(container, 12));
    // 定位的那一行确实是被标红的那一行（行号槽的 is-hit 与命中行底色同一来源）
    const hitRow = [...container.querySelectorAll<HTMLElement>(".code-ln")].find((el) => el.textContent === "12");
    expect(hitRow!.className).toContain("is-hit");
  });

  it("同一份正文里改外部搜索词：跟着定位新词的首个命中", () => {
    const { container, rerender } = render(view({ code: DEEP, searchTerm: "timeout", contentKey: "k1" }));
    const offsets = stubGeometry(container.querySelector(".code-area") as HTMLElement);
    offsets.top = expectedTopFor(container, 12);

    rerender(view({ code: DEEP, searchTerm: "key19", contentKey: "k1" }));

    expect(offsets.top).toBe(expectedTopFor(container, 20));
  });

  it("关掉查找栏不许把位置拽回第一处命中", async () => {
    const { container } = render(view({ code: DEEP, searchTerm: "timeout", contentKey: "k1" }));
    const offsets = stubGeometry(container.querySelector(".code-area") as HTMLElement);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    await waitFor(() => expect(container.querySelector(".code-find-input")).not.toBeNull());
    expect(offsets.top).toBe(expectedTopFor(container, 12));
    const firstHitTop = offsets.top;

    fireEvent.keyDown(container.querySelector(".code-find-input") as HTMLElement, { key: "Enter" }); // 下一处
    expect(offsets.top).toBe(expectedTopFor(container, 21));
    const lastHitTop = offsets.top;

    fireEvent.keyDown(container.querySelector(".code-find-input") as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".code-find-input")).toBeNull());
    // 关栏把净空退回 6px，行号层与命中行层的 top 一起上移，但**滚动位置该原样留着**：
    // 不许把刚看的那一处拽回第一处（这条用例的原始靶子）。
    // 这里不能再套 expectedTopFor()——它按当前净空算「该行居中」的目标值，而 jsdom 没有
    // scroll anchoring，净空变化不会顺手补偿 scrollTop（真机会补偿，用户眼里的位置同样不动）。
    expect(offsets.top, "关栏后滚动位置被改写了").toBe(lastHitTop);
    expect(offsets.top).not.toBe(firstHitTop);
    // 刚看的那一行还在渲染窗口内（净空变了也不能把窗口算漏），只是不再算当前命中
    expect([...container.querySelectorAll<HTMLElement>(".code-ln")].some((el) => el.textContent === "21")).toBe(true);
    expect([...container.querySelectorAll<HTMLElement>(".code-ln")].find((el) => el.textContent === "21")!.className).not.toContain(
      "is-current"
    );
  });

  it("视口量不到高度时不定位，退回纯归零（宿主被保活隐藏 / 首帧未布局）", () => {
    // 故意只撑出 scrollHeight：clientHeight 仍为 0，真跳一次会得到 clamp(226 - 0, 0, 600) = 226，
    // 于是「归零后再也没跳过」和「跳歪了」在这条用例里能被区分开。
    const { container, rerender } = render(view({ code: MULTI }));
    const pre = container.querySelector(".code-area") as HTMLElement;
    const offsets = stubGeometry(pre);
    Object.defineProperty(pre, "clientHeight", { configurable: true, get: () => 0 });
    offsets.top = 300;

    rerender(view({ code: DEEP, searchTerm: "timeout", contentKey: "k2" }));

    expect(offsets.top).toBe(0);
  });
});

describe("CodeView 跳下一处的滚动落地（轮29 F-17 / F-18）", () => {
  /** 全文只剩一处 timeout（第 12 行）：F-18 的症状只在「命中数为 1」时暴露。 */
  const SINGLE_HIT = `${DEEP_LINES.map((line, i) => (i === 20 ? "key20 = 20" : line)).join("\n")}\n`;

  /** 开查找栏并输入词，等命中落地。 */
  async function openFindWith(container: HTMLElement, needle: string) {
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    await waitFor(() => expect(container.querySelector(".code-find-input")).not.toBeNull());
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: needle } });
    await waitFor(() => expect(container.querySelector(".code-area mark.search-hit-current")).not.toBeNull());
    return input;
  }

  it("StrictMode 下按一次 Enter 只给 scrollTop 赋值一次", async () => {
    localStorage.setItem("locale", "zh-CN");
    const { container } = render(
      <StrictMode>
        <I18nProvider>
          <CodeView code={DEEP} format="TEXT" />
        </I18nProvider>
      </StrictMode>
    );
    const writes = { count: 0 };
    const offsets = stubGeometry(container.querySelector(".code-area") as HTMLElement, writes);
    const input = await openFindWith(container, "timeout");
    expect(offsets.top, "开栏 / 改词没把首个命中拉进视口").toBe(expectedTopFor(container, 12));
    writes.count = 0; // 只数 Enter 这一次提交

    fireEvent.keyDown(input, { key: "Enter" });

    expect(offsets.top, "Enter 没跳到第二处").toBe(expectedTopFor(container, 21));
    // 旧实现把滚动写在 setActiveIdx 的 updater 里：StrictMode 每次更新把 updater 调两遍，
    // 一次 Enter 就给 scrollTop 赋值两次（真浏览器里 React 未来重放 updater 同样会多滚）。
    expect(writes.count, "一次 Enter 给 scrollTop 赋了不止一次值：滚动又回到 setState updater 里了").toBe(1);
  });

  it("全文只有一处命中时 Enter / F3 仍把那一处拉回视口", async () => {
    const { container } = renderView(SINGLE_HIT, "TEXT");
    const offsets = stubGeometry(container.querySelector(".code-area") as HTMLElement);
    const input = await openFindWith(container, "timeout");
    const top = expectedTopFor(container, 12);
    expect(offsets.top).toBe(top);

    // 用户自己滚走了。命中只有 1 处时 (0 + 1 + 1) % 1 还是 0：F-17 把滚动挪出 updater 之后，
    // 序号没变就没有任何重渲染，落地效果不跑，看起来就是快捷键整个失效——navTick 是这条的解药。
    offsets.top = 0;
    fireEvent.keyDown(input, { key: "Enter" });
    expect(offsets.top, "命中只有一处时 Enter 一动不动").toBe(top);

    offsets.top = 0;
    // 打在输入框上（真机就是这个焦点态）：window 上做这件事会被 takesThisView 的「焦点在
    // 别处可编辑控件」那条挡掉，那是另一条口径，不属这条用例。
    fireEvent.keyDown(input, { key: "F3" });
    expect(offsets.top, "命中只有一处时 F3 一动不动").toBe(top);

    offsets.top = 0;
    fireEvent.keyDown(input, { key: "F3", shiftKey: true });
    expect(offsets.top, "命中只有一处时 Shift+F3 一动不动").toBe(top);

    offsets.top = 0;
    // 「上一处 / 下一处」按钮走同一条 navigate，症状一模一样；按 aria-label 取，类名是三个按钮共用
    fireEvent.click(container.querySelector('button[aria-label="下一处"]') as HTMLElement);
    expect(offsets.top, "命中只有一处时点「下一处」按钮一动不动").toBe(top);
  });
});

describe("CodeView 长行里的命中也横向送进视口（轮27 F-7）", () => {
  /** jsdom 无布局，假布局按「每字符 8px、整篇从 x=0 起排」量（见 ../test/codeLayout）。 */
  const CHAR_W = 8;
  const VIEWPORT_W = 800;
  /** 单行长 JSON：Nacos 里最常见的形态。needle 落在第 600 列之后，未修前红字整条在屏幕外。 */
  const LONG = `{"a":1,"pad":"${"x".repeat(600)}","serverPort":8080,"pad2":"${"y".repeat(300)}","serverHost":"127.0.0.1"}`;

  beforeEach(() => {
    // 查找口径走 viewState 记忆键（与编辑态同一对），别的用例写过的开关会污染这里的命中数
    clearViewState("codeFind.");
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  function view(props: { code: string; searchTerm?: string }) {
    localStorage.setItem("locale", "zh-CN");
    return (
      <I18nProvider>
        <CodeView format="TEXT" {...props} />
      </I18nProvider>
    );
  }

  /** 撑出横向布局：clientWidth / scrollWidth / 可写 scrollLeft / mark 矩形。 */
  function layout(container: HTMLElement) {
    const area = container.querySelector(".code-area") as HTMLElement;
    const scroll = stubCodeHorizontalLayout(area, area, {
      charWidth: CHAR_W,
      viewportWidth: VIEWPORT_W,
      contentWidth: LONG.length * CHAR_W,
    });
    Object.defineProperty(area, "clientHeight", { configurable: true, get: () => 100 });
    Object.defineProperty(area, "scrollHeight", { configurable: true, get: () => 200 });
    return { area, scroll };
  }

  function openFindWithTerm(container: HTMLElement, term: string) {
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    expect(input, "Ctrl+F 没能打开查找栏").toBeTruthy();
    fireEvent.change(input, { target: { value: term } });
    return input;
  }

  it("搜长行里的词：当前命中落进横向视口，且真的动过偏移（不是恰好停在 0 撞对）", async () => {
    const { container } = render(view({ code: LONG }));
    const { area, scroll } = layout(container);

    openFindWithTerm(container, "server");
    await waitFor(() => expect(container.querySelector(".code-area mark.search-hit-current")).not.toBeNull());

    const current = container.querySelector(".code-area mark.search-hit-current") as HTMLElement;
    expect(scroll.get(), "命中在第 600 列之后，scrollLeft 还停在 0 就是没定位").toBeGreaterThan(0);
    expect(isMarkVisible(area, current, HIT_REVEAL_MARGIN)).toBe(true);
  });

  it("Enter 换到下一处命中：横向跟着换到新的那一处，不留在上一处", async () => {
    const { container } = render(view({ code: LONG }));
    const { area, scroll } = layout(container);
    const input = openFindWithTerm(container, "server");
    await waitFor(() => expect(container.querySelector(".code-area mark.search-hit-current")).not.toBeNull());
    const leftAtFirst = scroll.get();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(container.querySelector(".code-area mark.search-hit-current")).not.toBeNull());

    const current = container.querySelector(".code-area mark.search-hit-current") as HTMLElement;
    expect(current.textContent).toBe("server");
    expect(scroll.get()).not.toBe(leftAtFirst);
    expect(isMarkVisible(area, current, HIT_REVEAL_MARGIN)).toBe(true);
  });

  it("内容搜索点开结果（查找栏没开，没有 current）：第一处红字也送进视口", () => {
    const { container, rerender } = render(view({ code: LONG }));
    const { area, scroll } = layout(container);

    rerender(view({ code: LONG, searchTerm: "server" }));

    const first = container.querySelector(".code-area mark.search-hit") as HTMLElement;
    expect(first, "外部搜索词整篇标红，不存在 current，就该退到第一处").toBeTruthy();
    expect(scroll.get()).toBeGreaterThan(0);
    expect(isMarkVisible(area, first, HIT_REVEAL_MARGIN)).toBe(true);
  });

  it("量不到布局时不许动：清掉用户已有的横向偏移比不定位更糟", async () => {
    const { container } = render(view({ code: LONG }));
    const area = container.querySelector(".code-area") as HTMLElement;
    // 只把 scrollLeft 换成可读写，clientWidth / scrollWidth 留在 0：真机对应「视图被保活隐藏」
    const scroll = stubScrollLeft(area);
    scroll.set(777);

    openFindWithTerm(container, "server");
    await waitFor(() => expect(container.querySelector(".code-find-input")).not.toBeNull());
    fireEvent.keyDown(container.querySelector(".code-find-input") as HTMLElement, { key: "Enter" });

    expect(scroll.get()).toBe(777);
  });
});

describe("CodeView 键盘可达（R39）", () => {
  it("正文能 Tab 停住，读屏念得出区域名", () => {
    const { container } = renderView(MULTI, "Properties");

    const region = screen.getByRole("region", { name: "内容" });
    expect(region).toBe(container.querySelector(".code-area"));
    expect(region).toHaveAttribute("tabindex", "0");
    // 焦点真能落上：落上之后方向键 / PageDown 就能滚正文
    region.focus();
    expect(document.activeElement).toBe(region);
  });
});

describe("CodeView 查找匹配选项（R75）", () => {
  /** 大小写与整词都在同一份正文里做对照：PORT 行 / port 行 / export 里的 port / ports。 */
  const CASE_CODE = "PORT = 1\nport = 2\nexport const port = 3\nports = 4\n";

  function openFindWithTerm(container: HTMLElement, term: string) {
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    expect(input, "Ctrl+F 没能打开查找栏（焦点残留在别的输入框上）").toBeTruthy();
    fireEvent.change(input, { target: { value: term } });
    return input;
  }

  function toggles(container: HTMLElement): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>(".code-find-toggle")];
  }

  function countText(container: HTMLElement): string {
    return (container.querySelector(".code-find-count") as HTMLElement).textContent ?? "";
  }

  /** 命中行 = 高亮层里那一行的横条（含「当前命中」那一行，它是 is-current 不是 is-hit）。 */
  function hitLineNumbers(container: HTMLElement): number[] {
    return [...container.querySelectorAll<HTMLElement>(".code-gutter .code-ln")]
      .filter((el) => el.classList.contains("is-hit") || el.classList.contains("is-current"))
      .map((el) => Number(el.textContent));
  }

  beforeEach(() => {
    // 开关走 viewState 记忆层（模块内存），不清掉就会互相污染：每条用例都从默认口径起步
    clearViewState("codeFind.");
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  it("查找栏里有两个开关，各自将「现在是开还是关」播报给辅助技术", () => {
    const { container } = renderView(CASE_CODE, "TEXT");
    openFindWithTerm(container, "port");

    const [caseBtn, wordBtn] = toggles(container);
    expect(caseBtn).toBeTruthy();
    expect(wordBtn).toBeTruthy();
    expect(caseBtn.getAttribute("aria-pressed")).toBe("false");
    expect(wordBtn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(caseBtn);
    expect(caseBtn.getAttribute("aria-pressed")).toBe("true");
    expect(wordBtn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(wordBtn);
    expect(wordBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("勾上区分大小写 / 全词后，命中数与命中行随之收窄", () => {
    const { container } = renderView(CASE_CODE, "TEXT");
    openFindWithTerm(container, "port");

    // 不区分大小写子串：PORT / port / export 里的 port / const port / ports 共 5 处、4 行
    expect(countText(container)).toContain("/5");
    expect(hitLineNumbers(container)).toEqual([1, 2, 3, 4]);

    fireEvent.click(toggles(container)[0]);
    expect(countText(container)).toContain("/4");
    expect(hitLineNumbers(container)).toEqual([2, 3, 4]);

    fireEvent.click(toggles(container)[1]);
    // 全词再把 export 与 ports 里的两处剔掉，只剩独立成词的 port
    expect(countText(container)).toContain("/2");
    expect(hitLineNumbers(container)).toEqual([2, 3]);
  });

  it("中文搜索词开了全词不会被变成死条件（独立成词仍能命中）", () => {
    const { container } = renderView("数据库端口配置 = 1\n端口 = 2\n", "TEXT");
    openFindWithTerm(container, "端口");
    expect(countText(container)).toContain("/2");

    fireEvent.click(toggles(container)[1]);
    expect(countText(container)).toContain("/1");
    expect(hitLineNumbers(container)).toEqual([2]);
  });

  it("点开关不抢走输入框焦点，也不关栏", () => {
    const { container } = renderView(CASE_CODE, "TEXT");
    const input = openFindWithTerm(container, "port");
    input.focus();
    expect(document.activeElement).toBe(input);

    const [caseBtn] = toggles(container);
    // fireEvent 返回 false 表示有处理器调用了 preventDefault：浏览器据此不移动焦点
    expect(fireEvent.mouseDown(caseBtn), "开关按下时没挡默认行为：点一下就得重新点输入框").toBe(false);

    fireEvent.click(caseBtn);
    expect(container.querySelector(".code-find-input")).toBe(input);
    expect(document.activeElement).toBe(input);
  });

  it("关掉查找栏后外部内容搜索词回到中性口径（与左侧列表命中数同源）", () => {
    const { container } = renderView(CASE_CODE, "TEXT", { searchTerm: "port" });
    expect(hitLineNumbers(container)).toEqual([1, 2, 3, 4]);

    openFindWithTerm(container, "port"); // 开栏时词沿用外部 searchTerm
    fireEvent.click(toggles(container)[0]); // 区分大小写
    expect(hitLineNumbers(container)).toEqual([2, 3, 4]); // PORT 那行退出

    fireEvent.keyDown(container.querySelector(".code-find-input") as HTMLElement, { key: "Escape" });
    // 栏一关，开关不参与：外部词必须继续大小写不敏感，否则代码标红和列表命中数分叉
    expect(container.querySelector(".code-find-input")).toBeNull();
    expect(hitLineNumbers(container)).toEqual([1, 2, 3, 4]);
  });

  it("开关只改标记层，.code-area 的文本内容逐字不变", () => {
    const { container } = renderView(CASE_CODE, "TEXT");
    openFindWithTerm(container, "port");
    const area = container.querySelector(".code-area") as HTMLElement;
    expect(area.textContent).toBe(CASE_CODE);

    fireEvent.click(toggles(container)[0]);
    fireEvent.click(toggles(container)[1]);
    expect(area.textContent).toBe(CASE_CODE);
    expect(container.innerHTML).not.toContain("&amp;amp;");
  });

  it("口径跨挂载记住：新文件的查找栏沿用上次选的口径", () => {
    const first = renderView(CASE_CODE, "TEXT");
    openFindWithTerm(first.container, "port");
    fireEvent.click(toggles(first.container)[0]);
    fireEvent.click(toggles(first.container)[1]);
    first.unmount();

    const second = renderView("port = 1\n", "TEXT");
    openFindWithTerm(second.container, "PORT");
    const [caseBtn, wordBtn] = toggles(second.container);
    expect(caseBtn.getAttribute("aria-pressed")).toBe("true");
    expect(wordBtn.getAttribute("aria-pressed")).toBe("true");
    // 记忆真的在起作用：区分大小写后大写 PORT 在这个文件里无命中
    expect(countText(second.container)).toContain("无匹配");
  });

  it("栏没打开时开关不参与计算：记住的口径不许污染外部搜索词", () => {
    // 上一次会话遗留「区分大小写 + 全词」：关着查找栏时外部内容搜索词必须继续全量标红，
    // 否则代码里的命中数会和左侧列表分叉（configContentSearch 的跨模块不变式）。
    writeViewState("codeFind.caseSensitive", true);
    writeViewState("codeFind.wholeWord", true);
    const { container } = renderView(CASE_CODE, "TEXT", { searchTerm: "port" });
    expect(container.querySelector(".code-find-input")).toBeNull();
    expect(hitLineNumbers(container)).toEqual([1, 2, 3, 4]);

    // 打开查找栏后，记住的口径才接管
    openFindWithTerm(container, "port");
    expect(hitLineNumbers(container)).toEqual([2, 3]);
  });
});

describe("CodeView 查找栏打开时把第一行让到条子下面（轮27 F-8）", () => {
  /**
   * jsdom 没有布局，条高量到 0 ⇒ 净空走 lib 的兜底常量（真机由 ResizeObserver 按实测值替换）。
   * 期望值一律从常量推，不在测试里抄第二份算式。
   */
  const OPEN_PAD = FIND_BAR_TOP + FIND_BAR_FALLBACK_HEIGHT + FIND_BAR_GAP;

  /** 借 prototype 上的 offsetHeight 假造条高：窄容器里查找栏 flex-wrap 成两行是真会发生的事。 */
  function fakeBarHeight(height: number) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => height });
    return () => {
      if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    };
  }

  function padTopOf(root: HTMLElement) {
    return root.style.getPropertyValue("--code-pad-top");
  }

  function rowTop(container: HTMLElement, selector: string, text: string) {
    const row = [...container.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent === text);
    expect(row, `${selector} 里没有这一行`).toBeTruthy();
    return parseFloat(row!.style.top);
  }

  it("开栏把净空从 6px 抬到条底之下，关栏原样退回", async () => {
    const { container } = renderView(MULTI, "Properties", { searchTerm: "8080" });
    const root = container.querySelector(".code-view") as HTMLElement;
    expect(padTopOf(root)).toBe("6px");
    expect(rowTop(container, ".code-ln", "1")).toBe(6);

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    await waitFor(() => expect(container.querySelector(".code-find-input")).not.toBeNull());

    expect(padTopOf(root)).toBe(`${OPEN_PAD}px`);
    // 第一行与命中行底色层都跟着净空走：条子占 8..42，两行都必须在 42 之下
    expect(rowTop(container, ".code-ln", "1")).toBe(OPEN_PAD);
    const barBottom = FIND_BAR_TOP + FIND_BAR_FALLBACK_HEIGHT;
    expect(rowTop(container, ".code-ln", "1") - barBottom).toBeGreaterThanOrEqual(FIND_BAR_GAP);
    expect(rowTop(container, ".code-line", "")).toBeGreaterThanOrEqual(OPEN_PAD);

    fireEvent.keyDown(container.querySelector(".code-find-input") as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".code-find-input")).toBeNull());
    expect(padTopOf(root)).toBe("6px");
    expect(rowTop(container, ".code-ln", "1")).toBe(6);
  });

  it("量到条子换成两行高 60px 时按实测算：留少了第一行照样被盖住", async () => {
    const restore = fakeBarHeight(60);
    try {
      const { container } = renderView(MULTI, "Properties");
      const root = container.querySelector(".code-view") as HTMLElement;
      fireEvent.keyDown(window, { key: "f", ctrlKey: true });
      await waitFor(() => expect(container.querySelector(".code-find-input")).not.toBeNull());

      const measured = FIND_BAR_TOP + 60 + FIND_BAR_GAP;
      expect(padTopOf(root)).toBe(`${measured}px`);
      expect(rowTop(container, ".code-ln", "1")).toBe(measured);
    } finally {
      restore();
    }
  });
});

describe("CodeView 查找词输入的延迟（轮29 F-16）", () => {
  /** 正好到阈值：这条用例钉的是「大文档不再逐字重标记整篇」，差一行都不算。 */
  const BIG = Array.from({ length: FIND_INPUT_DEFER_MIN_LINES }, (_, i) => `key${i}: spring-cloud-${i}`).join("\n");

  it("大文档敲字期间不动命中层，停顿后才落地；输入框始终是即时值", async () => {
    const { container } = renderView(BIG, "YAML");
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "spring" } });
    // 用户看得见自己敲的字（输入框即时），但整篇正文还没被重标记：
    // 实测每键 1 800ms（10MB）到 67ms（247KB），逐字实时就是「打一个字等半秒」。
    expect(input.value, "输入框该是即时值").toBe("spring");
    expect(container.querySelectorAll(".code-area mark.search-hit")).toHaveLength(0);

    await settleFindInputCommit();
    expect(container.querySelectorAll(".code-area mark.search-hit").length).toBeGreaterThan(0);
    expect((container.querySelector(".code-find-count") as HTMLElement).textContent).toBe(`第 1/${FIND_INPUT_DEFER_MIN_LINES} 处`);
    // 落地的是这一次输入，不是别的
    expect((container.querySelector(".code-find-input") as HTMLInputElement).value).toBe("spring");
  });

  it("还没提交就按 Enter：这一次只提交新词，不拿旧词的命中表跳格子", async () => {
    const { container } = renderView(BIG, "YAML");
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    const count = () => (container.querySelector(".code-find-count") as HTMLElement).textContent;

    fireEvent.change(input, { target: { value: "spring" } });
    // 停顿还没到，Enter 不能拿「旧词（空串）」的命中表数格子；这次按键只负责把新词提交。
    fireEvent.keyDown(input, { key: "Enter" });
    expect(count(), "Enter 应当立刻把没落地的词提交").toBe(`第 1/${FIND_INPUT_DEFER_MIN_LINES} 处`);
    // 提交过了就不该再有待触发的定时器：下一次 Enter 正常前进
    fireEvent.keyDown(input, { key: "Enter" });
    expect(count()).toBe("第 2/3000 处");
  });

  it("补一个字母凑出「无匹配」时，Enter 只提交新词，不许报旧词表里的「第 2/3000 处」（轮29 F-16 AC3 的另一半）", async () => {
    // 延迟落地自带一个错开：输入框里的词是即时值，命中表用的词还停在上一格。
    // 错开本身没事，出事的是「拿旧词的命中表数格子」——最刺眼的形状就是输入 springx（0 处命中）
    // 却显示「第 2/3000 处」：计数说的是一座已经不存在的桥。所以这次按键只许提交新词。
    // 顺带钉住另一头：凑不出命中的那个字母也必须留在输入框里，否则用户在长文档里永远打不出新词。
    const { container } = renderView(BIG, "YAML");
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    const count = () => (container.querySelector(".code-find-count") as HTMLElement).textContent;

    fireEvent.change(input, { target: { value: "spring" } });
    fireEvent.keyDown(input, { key: "Enter" }); // 提交：命中表是 spring 的 3000 处，停在第 1 处
    expect(count()).toBe("第 1/3000 处");

    fireEvent.change(input, { target: { value: "springx" } });
    expect(input.value, "最新那次输入必须留在输入框里，否则永远打不出 springx").toBe("springx");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(count(), "Enter 只负责提交新词：新词没有命中，不许报旧词表里的「第 2/3000 处」").toBe("无匹配");

    // 再补回有命中的词，同一条路径要能正常前进（提交一次落在第 1 处，下一次才前进）
    fireEvent.change(input, { target: { value: "spring" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(count()).toBe("第 1/3000 处");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(count()).toBe("第 2/3000 处");
  });
});

describe("CodeView 命中触顶要说得出口（轮28 F-10）", () => {
  /** 正好比上限多一处：少一处就该走「第 1/N 处」的精确文案，多一处就该报得出「+」。 */
  const CAPPED = Array.from({ length: MAX_CODE_HITS + 1 }, () => "port = 8080;").join("\n");

  it("未触顶时文案一字不改，也不挂解释 title", () => {
    const { container } = renderView(MULTI, "Properties");
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "port" } });
    const count = container.querySelector(".code-find-count") as HTMLElement;
    expect(count.textContent).toBe("第 1/2 处");
    expect(count.getAttribute("title")).toBeNull();
  });

  it("触顶后计数变成「第 x/5000+ 处」，DOM 里也只有 5000 个红字", async () => {
    const { container } = renderView(CAPPED, "Properties");
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = container.querySelector(".code-find-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "port" } });
    // 5001 行正文已过输入延迟阈值（轮29 F-16）：先让这次提交落地，再读命中
    await settleFindInputCommit();

    const count = container.querySelector(".code-find-count") as HTMLElement;
    expect(count.textContent).toBe(`第 1/${MAX_CODE_HITS}+ 处`);
    expect(count.getAttribute("title"), "限制本身要有一句解释").toContain(`只标红前 ${MAX_CODE_HITS} 处`);
    expect(container.querySelectorAll(".code-area mark.search-hit")).toHaveLength(MAX_CODE_HITS);
    // 正文契约不能被这批红字破坏
    expect((container.querySelector(".code-area") as HTMLElement).textContent).toBe(CAPPED);

    fireEvent.keyDown(input, { key: "Enter" });
    expect((container.querySelector(".code-find-count") as HTMLElement).textContent).toBe(`第 2/${MAX_CODE_HITS}+ 处`);
  });

  it("关回查找栏（外部搜索词同样触顶）：不报精确总数，也不留 title 上的空值", () => {
    const { container } = renderView(CAPPED, "Properties", { searchTerm: "port" });
    // 外部内容搜索路径没有查找栏，命中数只在列表侧播报，这里只保证红字数量被上限挡住
    expect(container.querySelectorAll(".code-area mark.search-hit")).toHaveLength(MAX_CODE_HITS);
  });
});

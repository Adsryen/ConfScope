/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import DiffPanel from "./DiffPanel";

function renderDiffPanel(props: Parameters<typeof DiffPanel>[0], locale = "zh-CN") {
  localStorage.setItem("locale", locale);
  return render(
    <I18nProvider>
      <DiffPanel {...props} />
    </I18nProvider>
  );
}

describe("DiffPanel", () => {
  it("shows an identical state and both labels", () => {
    renderDiffPanel({
      leftLabel: "dev/app.yaml",
      rightLabel: "prod/app.yaml",
      leftText: "server.port=8080",
      rightText: "server.port=8080",
      format: "TEXT",
    });

    expect(screen.getByText("✓ 两侧内容完全一致")).toBeInTheDocument();
    expect(screen.getByText("dev/app.yaml")).toBeInTheDocument();
    expect(screen.getByText("prod/app.yaml")).toBeInTheDocument();
  });

  it("shows diff counters for changed content", () => {
    renderDiffPanel({
      leftLabel: "left",
      rightLabel: "right",
      leftText: "a\nb",
      rightText: "a\nc\nd",
      format: "TEXT",
    });

    expect(document.querySelector(".stat-add")).toHaveTextContent("+1 新增");
    expect(document.querySelector(".stat-del")).toHaveTextContent("−0 删除");
    expect(document.querySelector(".stat-mod")).toHaveTextContent("~1 修改");
  });

  it("can show only changed rows", () => {
    renderDiffPanel({
      leftLabel: "left",
      rightLabel: "right",
      leftText: "same\nold",
      rightText: "same\nnew",
    });

    expect(screen.getAllByText("same")).toHaveLength(2);

    fireEvent.click(screen.getByLabelText("仅显示变更"));

    expect(screen.queryByText("same")).not.toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("can be controlled by a parent only-changes switch", () => {
    renderDiffPanel({
      leftLabel: "left",
      rightLabel: "right",
      leftText: "same\nold",
      rightText: "same\nnew",
      onlyChanges: true,
      hideOnlyChangesToggle: true,
    });

    expect(screen.queryByText("same")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("仅显示变更")).not.toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("localizes stats, toggle, and empty changed-row state", () => {
    renderDiffPanel(
      {
        leftLabel: "left",
        rightLabel: "right",
        leftText: "server.port=8080",
        rightText: "server.port=8080",
        format: "TEXT",
      },
      "en-US"
    );

    expect(screen.getByText("Both sides are identical")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Only show changes"));
    expect(screen.getByText("No difference rows")).toBeInTheDocument();
  });

  it("renders block merge as one bracketed action for contiguous changed rows", () => {
    const onMergeAction = vi.fn();
    renderDiffPanel(
      {
        leftLabel: "left",
        rightLabel: "right",
        leftText: `same
old-one
old-two
done`,
        rightText: `same
new-one
new-two
done`,
        format: "TEXT",
        mergeActionScope: "block",
        mergeActionLabels: {
          leftToRight: "Take left block to right preview",
          rightToLeft: "Take right block to left preview",
        },
        onMergeAction,
      },
      "en-US"
    );

    expect(screen.getAllByRole("button", { name: "Take left block to right preview" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Take right block to left preview" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Keep this block" })).not.toBeInTheDocument();
    expect(document.querySelectorAll(".diff-merge-center .diff-merge-block-brace")).toHaveLength(2);
    expect(document.querySelectorAll(".diff-merge-block-brace")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Take left block to right preview" }));

    expect(onMergeAction).toHaveBeenCalledWith(1, "left-to-right", [1, 2]);
  });

  it("keeps single-row merge actions split without block braces", () => {
    renderDiffPanel(
      {
        leftLabel: "left",
        rightLabel: "right",
        leftText: "old",
        rightText: "new",
        format: "TEXT",
        mergeActionScope: "block",
        mergeActionLabels: {
          leftToRight: "Take left block to right preview",
          rightToLeft: "Take right block to left preview",
        },
        onMergeAction: vi.fn(),
      },
      "en-US"
    );

    expect(document.querySelector(".diff-merge-center .diff-merge-btn.right-to-left")).toBeInTheDocument();
    expect(document.querySelector(".diff-merge-center .diff-merge-btn.left-to-right")).toBeInTheDocument();
    expect(document.querySelector(".diff-merge-block-brace")).not.toBeInTheDocument();
  });

  it("localizes changed diff counters", () => {
    renderDiffPanel(
      {
        leftLabel: "left",
        rightLabel: "right",
        leftText: "a\nb",
        rightText: "a\nc\nd",
        format: "TEXT",
      },
      "en-US"
    );

    expect(document.querySelector(".stat-add")).toHaveTextContent("+1 added");
    expect(document.querySelector(".stat-del")).toHaveTextContent("-0 deleted");
    expect(document.querySelector(".stat-mod")).toHaveTextContent("~1 modified");
  });
});

describe("DiffPanel 加不进去的箭头要说清为什么（轮27 F-9）", () => {
  const LABELS = { leftToRight: "拿左侧到右侧预览", rightToLeft: "拿右侧到左侧预览" };

  function renderWithAvailability(availability: { "left-to-right"?: boolean }, onMergeAction = vi.fn(), withReason = true) {
    renderDiffPanel({
      leftLabel: "left",
      rightLabel: "right",
      leftText: "a\nb",
      rightText: "a\nc\nd",
      format: "TEXT",
      mergeActionLabels: LABELS,
      mergeActionAvailability: availability,
      mergeActionUnavailableReason: withReason ? "左侧没有这一项，箭头暂时加不进去" : undefined,
      onMergeAction,
    });
    return { arrow: document.querySelector(".diff-merge-btn.left-to-right") as HTMLButtonElement, onMergeAction };
  }

  it("不可用时不写原生 disabled：那样 Blink 连 title 都不弹，理由等于没写", () => {
    const { arrow } = renderWithAvailability({ "left-to-right": false });
    expect(arrow.hasAttribute("disabled"), "原生 disabled 会把 title 一起吞掉").toBe(false);
    expect(arrow.getAttribute("aria-disabled")).toBe("true");
    expect(arrow.getAttribute("title")).toBe("左侧没有这一项，箭头暂时加不进去");
    // 动作名继续走 aria-label：读屏念得出「这是干什么的」，再加上 aria-disabled 的不可用播报
    expect(arrow.getAttribute("aria-label")).toBe("拿左侧到右侧预览");
  });

  it("点不可用的箭头不产生合并动作（Enter / Space 在原生 button 上就是合成一次 click，同一道闸）", () => {
    const { arrow, onMergeAction } = renderWithAvailability({ "left-to-right": false });
    fireEvent.click(arrow);
    fireEvent.click(arrow);
    expect(onMergeAction).not.toHaveBeenCalled();
  });

  it("可用时照旧：title 是动作名，点一下就把这一行标成合并草稿", () => {
    const { arrow, onMergeAction } = renderWithAvailability({ "left-to-right": true });
    expect(arrow.getAttribute("aria-disabled")).toBeNull();
    expect(arrow.getAttribute("title")).toBe("拿左侧到右侧预览");
    fireEvent.click(arrow);
    expect(onMergeAction).toHaveBeenCalledTimes(1);
  });

  it("宿主没给理由时 title 退回动作名，不许留空", () => {
    const { arrow } = renderWithAvailability({ "left-to-right": false }, vi.fn(), false);
    expect(arrow.getAttribute("title")).toBe("拿左侧到右侧预览");
  });

  it("右侧那颗依旧只在可用时渲染，同时删掉了永远取 false 的 disabled", () => {
    const { container } = renderDiffPanel({
      leftLabel: "left",
      rightLabel: "right",
      leftText: "a",
      rightText: "a\nb",
      format: "TEXT",
      mergeActionLabels: LABELS,
      mergeActionAvailability: { "right-to-left": false, "left-to-right": true },
      onMergeAction: vi.fn(),
    });
    expect(container.querySelector(".diff-merge-btn.right-to-left")).toBeNull();
    const left = container.querySelector(".diff-merge-btn.left-to-right") as HTMLButtonElement;
    expect(left.hasAttribute("disabled")).toBe(false);
    expect(left.getAttribute("aria-disabled")).toBeNull();
  });
});

/**
 * 外部内容搜索词这一条路径（轮55 C线补上）。
 *
 * 批量对比左栏的跨项搜索要把词一路传到 diff 里标红，走的是 CodeView 早就定好的那一句话：
 * 查找栏没开 ⇒ 外部词接管整篇标红；栏一开 ⇒ 栏内的词接管（开栏时拿外部词做种子，
 * 用户改了就听用户的）；关栏 ⇒ 外部词继续。谁多看一眼都不该以为搜索坏了。
 */
describe("DiffPanel 外部内容搜索词（轮55 C线）", () => {
  const EXTERNAL = {
    leftLabel: "dev/app.yaml",
    rightLabel: "prod/app.yaml",
    // 左 2 处 port + 1 处 keep，右 1 处 port：两侧都要标到，不能只标变更行
    leftText: "port: 8080\nkeep: 1\nport: 8081",
    rightText: "port: 9090",
    format: "TEXT" as const,
  };

  const hitMarks = () => document.querySelectorAll(".diff-cell mark.search-hit");

  it("没给词时一处都不标，给了词两侧一起标", () => {
    renderDiffPanel({ ...EXTERNAL });
    expect(hitMarks()).toHaveLength(0);
    renderDiffPanel({ ...EXTERNAL, searchTerm: "port" });
    expect(hitMarks().length).toBeGreaterThanOrEqual(3);
  });

  it("词只命中一侧时另一侧保持干净（A 有 B 没有要看得见）", () => {
    renderDiffPanel({ ...EXTERNAL, searchTerm: "keep" });
    const marks = hitMarks();
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toContain("keep");
  });

  it("开栏用外部词做种子，栏内改词由栏接管，关栏回到外部词", () => {
    renderDiffPanel({ ...EXTERNAL, searchTerm: "port" });
    expect(hitMarks().length).toBeGreaterThanOrEqual(3);

    fireEvent.click(screen.getByRole("button", { name: "在此文件查找（Ctrl+F）" }));
    const bar = screen.getByLabelText("在当前文件查找…") as HTMLInputElement;
    expect(bar.value).toBe("port");

    fireEvent.change(bar, { target: { value: "keep" } });
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(hitMarks()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "关闭查找" }));
    expect(hitMarks().length).toBeGreaterThanOrEqual(3);
  });
});

describe("DiffPanel 外部搜索词的定位（轮56）", () => {
  const ROW_H = 20;
  const VIEW_H = 200;
  const LINES = Array.from({ length: 30 }, (_, i) => `line-${i}`);
  LINES[20] = "idle-timeout: 60";
  // TERM_B 故意命中**两**行：只命中一行的话「第一处」和「最后一处」是同一个数，
  // 把定位写成 groups[length-1] 都不会红（轮56 起草时实测过这条变异）。
  LINES[26] = "tail-marker: on";
  LINES[29] = "tail-marker: off";
  const TEXT = LINES.join("\n");
  /** 换正文那条出口用的第二份正文：同一个词落在另一行上。 */
  const TEXT2 = LINES.map((line, i) => (i === 20 ? "line-20" : i === 26 ? "idle-timeout: 60" : line)).join("\n");
  const TERM_A = "idle-timeout";
  const TERM_B = "tail-marker";
  const MISS = "no-such-key-9z7x";

  type PanelProps = Parameters<typeof DiffPanel>[0];
  const panelProps = (props: Partial<PanelProps>): PanelProps =>
    ({ leftLabel: "dev/app.yaml", rightLabel: "prod/app.yaml", format: "TEXT", leftText: TEXT, rightText: TEXT, ...props }) as PanelProps;
  const tree = (props: PanelProps) => (
    <I18nProvider>
      <DiffPanel {...props} />
    </I18nProvider>
  );

  const body = () => document.querySelector<HTMLElement>(".diff-body")!;
  /** 第一处命中落在第几行（按 DOM 现查，不按用例自己数的偏移猜）。 */
  const firstHitRow = () =>
    Array.from(body().querySelectorAll<HTMLElement>(".diff-row")).findIndex((row) => Boolean(row.querySelector("mark.search-hit")));
  /**
   * 居中口径只有 lib/codeScroll 那一份实现。这里按同一套假几何复算一遍，
   * 为的是断言「落在第一处命中」，而不是「随便滚了一下」——只断 >0 的话，
   * 滚到第二处、滚到文件尾都能过，等于没钉。
   */
  const expectedScrollTop = (rowIndex: number) => rowIndex * ROW_H - (VIEW_H - ROW_H) / 2;

  /**
   * jsdom 没有布局：clientHeight / scrollHeight / getBoundingClientRect 恒为 0，
   * revealRowVertically 量不到矩形就返回 false（那是它该有的行为，不是本组用例要验的）。
   * 行元素会被 React 重建，所以矩形挂在 Element.prototype 上按 data-row-index 现算，
   * 只有滚动容器那两个尺寸挂在具体节点上（.diff-body 跨重渲染是同一个元素）。
   */
  function makeScrollable() {
    const el = body();
    Object.defineProperty(el, "clientHeight", { configurable: true, get: () => VIEW_H });
    Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 4_000 });
  }

  let rectSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    localStorage.setItem("locale", "zh-CN");
    rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const row = this.closest(".diff-row");
      const top = row ? Number(row.getAttribute("data-row-index") ?? 0) * ROW_H : 0;
      return { top, bottom: top + ROW_H, height: ROW_H, left: 0, right: 120, width: 120, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
  });
  afterEach(() => rectSpy.mockRestore());

  it("同一份正文里改词：新词的第一处命中被滚进视口，而不是停在文件开头", () => {
    const { rerender } = render(tree(panelProps({ searchTerm: TERM_A })));
    // 挂载这一帧还没量得到高度（假几何是渲染后才装的），所以此刻不该有任何滚动
    expect(body().scrollTop).toBe(0);
    makeScrollable();
    expect(firstHitRow()).toBe(20);

    rerender(tree(panelProps({ searchTerm: TERM_B })));
    expect(firstHitRow()).toBe(26);
    expect(body().scrollTop).toBe(expectedScrollTop(26));
  });

  it("换文件（批量态点下一个 dataId，两侧标签一起变）：归零之后紧接着定位，不闪文件开头", () => {
    const { rerender } = render(tree(panelProps({ searchTerm: TERM_A })));
    makeScrollable();
    rerender(
      tree(
        panelProps({
          searchTerm: TERM_A,
          leftText: TEXT2,
          rightText: TEXT2,
          leftLabel: "dev/app-b.yaml",
          rightLabel: "prod/app-b.yaml",
        })
      )
    );
    // 词没变、这一屏换成了另一对文件：宿主挂在 useScrollResetOnContentChange 上的 onReset 走这一拽
    expect(firstHitRow()).toBe(26);
    expect(body().scrollTop).toBe(expectedScrollTop(26));
  });

  it("归零看的是「换没换文件」，不是「正文变没变」：换文件只换标签、正文逐字相同也要归零", () => {
    const { rerender } = render(tree(panelProps({})));
    makeScrollable();
    body().scrollTop = 500;
    // 两份文件内容一模一样（批量态里相邻两项常有一样的正文），只有标签换了
    rerender(tree(panelProps({ leftLabel: "dev/app-b.yaml", rightLabel: "prod/app-b.yaml" })));
    expect(body().scrollTop).toBe(0);
  });

  it("同一对文件被就地改内容（点合并箭头、微调右侧）：滚动位置必须保住，不许跳回开头", () => {
    const { rerender } = render(tree(panelProps({ searchTerm: TERM_A })));
    makeScrollable();
    body().scrollTop = 500;
    // 标签没换、只有右侧正文被合并改掉：用户看的就是这一屏，跳顶会把他的位置弄丢（轮134 缺陷 A）
    rerender(tree(panelProps({ searchTerm: TERM_A, rightText: TEXT2 })));
    expect(body().scrollTop, "同一对文件的正文改动把滚动拽回了第一处命中").toBe(500);
  });

  it("零命中不插手：停在用户正看着的地方，不许把他弹回开头", () => {
    const { rerender } = render(tree(panelProps({ searchTerm: TERM_A })));
    makeScrollable();
    body().scrollTop = 500;
    rerender(tree(panelProps({ searchTerm: MISS })));
    expect(body().querySelectorAll("mark.search-hit")).toHaveLength(0);
    expect(body().scrollTop).toBe(500);
  });

  it("量不到高度不插手：视图被保活隐藏时，跳一次等于没跳，还会把定位成功演成假绿", () => {
    const { rerender } = render(tree(panelProps({ searchTerm: TERM_A })));
    // 故意不装假几何：clientHeight 与矩形恒量不到，等价于 .diff-body 在隐藏祖先里。
    // 判据在 lib/codeScroll 那一层（本层不重复写），这条用例钉的是最终行为。
    body().scrollTop = 500;
    rerender(tree(panelProps({ searchTerm: TERM_B })));
    expect(body().scrollTop).toBe(500);
  });

  it("查找栏开着时外部词不抢这一拽：栏有自己的当前命中语义（Enter / F3）", () => {
    const { rerender } = render(tree(panelProps({ searchTerm: TERM_A })));
    makeScrollable();
    fireEvent.click(screen.getByRole("button", { name: "在此文件查找（Ctrl+F）" }));
    // 栏内词以外部词为种子，命中表由栏接管；用户随后自己滚开
    body().scrollTop = 500;
    rerender(tree(panelProps({ searchTerm: TERM_B })));
    expect(body().scrollTop).toBe(500);
  });

  it("词与正文都没变的后续重渲染，不得把用户拽回第一处", () => {
    const { rerender } = render(tree(panelProps({ searchTerm: TERM_A })));
    makeScrollable();
    rerender(tree(panelProps({ searchTerm: TERM_B })));
    expect(body().scrollTop).toBe(expectedScrollTop(26));
    body().scrollTop = 500;
    rerender(tree(panelProps({ searchTerm: TERM_B })));
    expect(body().scrollTop).toBe(500);
  });
});

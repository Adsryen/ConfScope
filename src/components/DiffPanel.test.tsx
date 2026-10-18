/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { describe, expect, it, vi } from "vitest";
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

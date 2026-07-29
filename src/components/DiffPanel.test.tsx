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
    renderDiffPanel(
      {
        leftLabel: "dev/app.yaml",
        rightLabel: "prod/app.yaml",
        leftText: "server.port=8080",
        rightText: "server.port=8080",
        format: "TEXT",
      }
    );

    expect(screen.getByText("✓ 两侧内容完全一致")).toBeInTheDocument();
    expect(screen.getByText("dev/app.yaml")).toBeInTheDocument();
    expect(screen.getByText("prod/app.yaml")).toBeInTheDocument();
  });

  it("shows diff counters for changed content", () => {
    renderDiffPanel(
      {
        leftLabel: "left",
        rightLabel: "right",
        leftText: "a\nb",
        rightText: "a\nc\nd",
        format: "TEXT",
      }
    );

    expect(document.querySelector(".stat-add")).toHaveTextContent("+1 新增");
    expect(document.querySelector(".stat-del")).toHaveTextContent("−0 删除");
    expect(document.querySelector(".stat-mod")).toHaveTextContent("~1 修改");
  });

  it("can show only changed rows", () => {
    renderDiffPanel(
      {
        leftLabel: "left",
        rightLabel: "right",
        leftText: "same\nold",
        rightText: "same\nnew",
      }
    );

    expect(screen.getAllByText("same")).toHaveLength(2);

    fireEvent.click(screen.getByLabelText("仅显示变更"));

    expect(screen.queryByText("same")).not.toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("can be controlled by a parent only-changes switch", () => {
    renderDiffPanel(
      {
        leftLabel: "left",
        rightLabel: "right",
        leftText: "same\nold",
        rightText: "same\nnew",
        onlyChanges: true,
        hideOnlyChangesToggle: true,
      }
    );

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
          keep: "Keep this block",
        },
        onMergeAction,
      },
      "en-US"
    );

    expect(screen.getAllByRole("button", { name: "Take left block to right preview" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Take right block to left preview" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Keep this block" })).toHaveLength(1);
    expect(document.querySelectorAll(".diff-merge-gutter.block-first")).toHaveLength(1);
    expect(document.querySelectorAll(".diff-merge-gutter.block-last")).toHaveLength(1);
    expect(document.querySelectorAll(".diff-merge-block-brace")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Take left block to right preview" }));

    expect(onMergeAction).toHaveBeenCalledWith(1, "left-to-right", [1, 2]);
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

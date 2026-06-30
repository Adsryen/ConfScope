/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { describe, expect, it } from "vitest";
import DiffPanel from "./DiffPanel";

describe("DiffPanel", () => {
  it("shows an identical state and both labels", () => {
    render(
      <DiffPanel
        leftLabel="dev/app.yaml"
        rightLabel="prod/app.yaml"
        leftText="server.port=8080"
        rightText="server.port=8080"
        format="TEXT"
      />
    );

    expect(screen.getByText("✓ 两侧内容完全一致")).toBeInTheDocument();
    expect(screen.getByText("dev/app.yaml")).toBeInTheDocument();
    expect(screen.getByText("prod/app.yaml")).toBeInTheDocument();
  });

  it("shows diff counters for changed content", () => {
    render(
      <DiffPanel
        leftLabel="left"
        rightLabel="right"
        leftText={"a\nb"}
        rightText={"a\nc\nd"}
        format="TEXT"
      />
    );

    expect(document.querySelector(".stat-add")).toHaveTextContent("+1 新增");
    expect(document.querySelector(".stat-del")).toHaveTextContent("−0 删除");
    expect(document.querySelector(".stat-mod")).toHaveTextContent("~1 修改");
  });

  it("can show only changed rows", () => {
    render(
      <DiffPanel
        leftLabel="left"
        rightLabel="right"
        leftText={"same\nold"}
        rightText={"same\nnew"}
      />
    );

    expect(screen.getAllByText("same")).toHaveLength(2);

    fireEvent.click(screen.getByLabelText("仅显示变更"));

    expect(screen.queryByText("same")).not.toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("can be controlled by a parent only-changes switch", () => {
    render(
      <DiffPanel
        leftLabel="left"
        rightLabel="right"
        leftText={"same\nold"}
        rightText={"same\nnew"}
        onlyChanges
        hideOnlyChangesToggle
      />
    );

    expect(screen.queryByText("same")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("仅显示变更")).not.toBeInTheDocument();
    expect(screen.getByText("old")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
  });
});

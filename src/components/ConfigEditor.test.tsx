/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { clearErrors, subscribeErrors, type AppErrorItem } from "../lib/errorCenter";
import type { Connection } from "../store/connections";
import { loadOperationHistory } from "../store/operationHistory";
import ConfigEditor from "./ConfigEditor";

const apiMocks = vi.hoisted(() => ({
  publishConfig: vi.fn(),
}));

vi.mock("../api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../api/nacos")>("../api/nacos");
  return {
    ...actual,
    publishConfig: apiMocks.publishConfig,
  };
});

const conn: Connection = {
  id: "dev",
  name: "dev",
  baseUrl: "http://localhost:8848/nacos",
  username: "nacos",
  password: "nacos",
  defaultNamespace: "",
};

function renderEditor(props: Partial<Parameters<typeof ConfigEditor>[0]> = {}, locale = "zh-CN") {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  localStorage.setItem("locale", locale);
  return {
    onClose,
    onSaved,
    ...render(
      <I18nProvider>
        <ConfigEditor
          conn={conn}
          namespace="public"
          onClose={onClose}
          onSaved={onSaved}
          {...props}
        />
      </I18nProvider>
    ),
  };
}

function fieldByLabel(label: string): HTMLInputElement {
  return screen.getByText(label).closest("label")!.querySelector("input")!;
}

function editorTextarea(): HTMLTextAreaElement {
  return document.querySelector("textarea")!;
}

function latestError(): AppErrorItem | undefined {
  let errors: AppErrorItem[] = [];
  const unsubscribe = subscribeErrors((items) => {
    errors = items;
  });
  unsubscribe();
  return errors[errors.length - 1];
}

describe("ConfigEditor", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
    apiMocks.publishConfig.mockReset();
    apiMocks.publishConfig.mockResolvedValue(undefined);
  });

  it("requires a dataId before publishing", () => {
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "发布" }));

    expect(screen.getByText("Data ID 不能为空")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
  });

  it("blocks publish when the content fails format validation", async () => {
    renderEditor();

    fireEvent.change(fieldByLabel("Data ID"), { target: { value: "app.yaml" } });
    fireEvent.change(editorTextarea(), {
      target: { value: "server:\n  port: 8080\n  port: 9090" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发布" }));

    expect(await screen.findByText("格式校验未通过")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
  });

  it("blocks direct publish before it can reach the API", async () => {
    const { onSaved } = renderEditor({}, "en-US");

    fireEvent.change(fieldByLabel("Data ID"), { target: { value: " app.yaml " } });
    fireEvent.change(fieldByLabel("Group"), { target: { value: " " } });
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByText("Direct config writes are disabled. Generate and execute an ApplyPlan instead.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Error" })).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "publish",
      result: "failure",
      dataId: "app.yaml",
      afterContent: "server:\n  port: 8080",
      rollbackable: false,
      rollbackReason: "operationHistory.rollbackOnlySuccess",
      error: "Direct config writes are disabled. Generate and execute an ApplyPlan instead.",
    });
  });

  it("shows the direct publish block without closing the editor", async () => {
    const { onSaved } = renderEditor({}, "en-US");

    fireEvent.change(fieldByLabel("Data ID"), { target: { value: "app.yaml" } });
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByText("Direct config writes are disabled. Generate and execute an ApplyPlan instead.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Error" })).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByText("New Configuration")).toBeInTheDocument();
    expect(loadOperationHistory()[0]).toMatchObject({
      type: "publish",
      result: "failure",
      dataId: "app.yaml",
      afterContent: "server:\n  port: 8080",
      rollbackable: false,
      error: "Direct config writes are disabled. Generate and execute an ApplyPlan instead.",
    });
  });

  it("reports direct publish blocks with localized message-center actions", async () => {
    renderEditor({}, "en-US");

    fireEvent.change(fieldByLabel("Data ID"), { target: { value: "app.yaml" } });
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByText("Direct config writes are disabled. Generate and execute an ApplyPlan instead.")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(latestError()).toMatchObject({
      title: "Failed to create config",
      message: "Direct config writes are disabled. Generate and execute an ApplyPlan instead.",
      actionLabel: "Retry Publish",
    });
  });
});

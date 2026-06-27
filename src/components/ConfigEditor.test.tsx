/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import type { Connection } from "../store/connections";
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

function renderEditor(props: Partial<Parameters<typeof ConfigEditor>[0]> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  localStorage.setItem("locale", "zh-CN");
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

describe("ConfigEditor", () => {
  beforeEach(() => {
    localStorage.clear();
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

  it("publishes trimmed dataId and default group", async () => {
    const { onSaved } = renderEditor();

    fireEvent.change(fieldByLabel("Data ID"), { target: { value: " app.yaml " } });
    fireEvent.change(fieldByLabel("Group"), { target: { value: " " } });
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });
    fireEvent.click(screen.getByRole("button", { name: "发布" }));

    await waitFor(() => {
      expect(apiMocks.publishConfig).toHaveBeenCalledWith(
        conn,
        "public",
        "app.yaml",
        "DEFAULT_GROUP",
        "server:\n  port: 8080",
        "yaml"
      );
    });
    expect(onSaved).toHaveBeenCalledWith("app.yaml", "DEFAULT_GROUP");
  });

  it("shows publish errors without closing the editor", async () => {
    apiMocks.publishConfig.mockRejectedValue(new Error("publish failed"));
    const { onSaved } = renderEditor();

    fireEvent.change(fieldByLabel("Data ID"), { target: { value: "app.yaml" } });
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });
    fireEvent.click(screen.getByRole("button", { name: "发布" }));

    expect(await screen.findByText("Error: publish failed")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByText("新建配置")).toBeInTheDocument();
  });
});

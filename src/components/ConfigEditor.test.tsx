/**
 * @vitest-environment jsdom
 */
import { clickOverlay, fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { clearErrors, subscribeErrors, type AppErrorItem } from "../lib/errorCenter";
import type { Connection } from "../store/connections";
import { loadOperationHistory } from "../store/operationHistory";
import type { ApplyEntryPayload } from "../lib/applyEntry";
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
  const onStartApply = vi.fn();
  localStorage.setItem("locale", locale);
  return {
    onClose,
    onStartApply,
    ...render(
      <I18nProvider>
        <ConfigEditor
          conn={conn}
          namespace="public"
          onClose={onClose}
          onStartApply={onStartApply}
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

  it("requires a dataId before generating the plan", () => {
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "生成变更计划" }));

    expect(screen.getByText("Data ID 不能为空")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
  });

  it("校验错误带行号时可一键跳到出错行（R28）", async () => {
    renderEditor();
    const content = "server:\n  port: 8080\n  port: 9090\n";

    fireEvent.change(fieldByLabel("Data ID"), { target: { value: "app.yaml" } });
    fireEvent.change(editorTextarea(), { target: { value: content } });
    fireEvent.click(screen.getByRole("button", { name: "生成变更计划" }));

    const jump = await screen.findByRole("button", { name: /跳到第 \d+ 行/ });
    fireEvent.click(jump);

    const ta = editorTextarea();
    expect(ta.value).toBe(content); // 跳转不改草稿
    const line = Number.parseInt(/跳到第 (\d+) 行/.exec(jump.textContent ?? "")?.[1] ?? "", 10);
    const rows = content.split("\n");
    const start = rows.slice(0, line - 1).reduce((acc, row) => acc + row.length + 1, 0);
    expect(ta.selectionStart).toBe(start);
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe(rows[line - 1]);
    expect(document.activeElement).toBe(ta); // 焦点回到编辑区，可以直接改
  });

  it("blocks plan generation when the content fails format validation", async () => {
    renderEditor();

    fireEvent.change(fieldByLabel("Data ID"), { target: { value: "app.yaml" } });
    fireEvent.change(editorTextarea(), {
      target: { value: "server:\n  port: 8080\n  port: 9090" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成变更计划" }));

    expect(await screen.findByText("格式校验未通过")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
  });

  // 轮42 / 方案 D：新建弹层的「发布」按钮改叫「生成变更计划」，走的也是那条唯一 sanctioned 链路。
  // 关键在于**不再产生假失败**：用户没做错事，操作历史里不该出现 result:"failure" 的新建记录。
  it("hands the new-config draft to a change plan instead of faking a failed publish", async () => {
    const { onStartApply } = renderEditor({}, "en-US");

    fireEvent.change(fieldByLabel("Data ID"), { target: { value: " app.yaml " } });
    fireEvent.change(fieldByLabel("Group"), { target: { value: " " } });
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate change plan" }));

    await waitFor(() => expect(onStartApply).toHaveBeenCalledTimes(1));
    const payload = onStartApply.mock.calls[0][0] as ApplyEntryPayload;
    expect(payload).toMatchObject({ sourceType: "manual", scope: "config" });
    expect(payload.origin?.returnMode).toBe("browse");
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]).toMatchObject({
      dataId: "app.yaml",
      group: "DEFAULT_GROUP",
      key: "__document",
    });
    // 草稿就是计划的来源值：正文与线上现值不一致时才会生成覆盖/新增项
    expect(payload.items[0].sourceValueOverride?.content).toBe("server:\n  port: 8080");
    expect(payload.items[0].sourceValueOverride?.exists).toBe(true);
    expect(payload.items[0].sourceRef).toEqual(payload.items[0].targetRef);

    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(loadOperationHistory()).toEqual([]);
    expect(latestError()).toBeUndefined();
  });

  it("keeps the draft open after generating the plan so the user can still edit it", async () => {
    const { onClose, onStartApply } = renderEditor();

    fireEvent.change(fieldByLabel("Data ID"), { target: { value: "app.yaml" } });
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });
    fireEvent.click(screen.getByRole("button", { name: "生成变更计划" }));

    await waitFor(() => expect(onStartApply).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("新建配置")).toBeInTheDocument();
    expect(editorTextarea().value).toBe("server:\n  port: 8080");
  });

  it("tells the user the plan route is unavailable instead of pretending a publish failed", async () => {
    const { onStartApply } = renderEditor({ onStartApply: undefined });

    fireEvent.change(fieldByLabel("Data ID"), { target: { value: "app.yaml" } });
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });
    fireEvent.click(screen.getByRole("button", { name: "生成变更计划" }));

    expect(await screen.findByText("当前页面无法打开变更计划")).toBeInTheDocument();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(onStartApply).not.toHaveBeenCalled();
    expect(loadOperationHistory()).toEqual([]);
  });

  it("只读连接不给新建弹层留出路：同样如实告知，不写操作历史", async () => {
    const { onStartApply } = renderEditor({ conn: { ...conn, readonly: true } });

    fireEvent.change(fieldByLabel("Data ID"), { target: { value: "app.yaml" } });
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });
    fireEvent.click(screen.getByRole("button", { name: "生成变更计划" }));

    expect(await screen.findByText("当前页面无法打开变更计划")).toBeInTheDocument();
    expect(onStartApply).not.toHaveBeenCalled();
    expect(loadOperationHistory()).toEqual([]);
  });


  // ---- 波13 / 轮5 R36：新建配置是「手写 YAML 的唯一落点」，关掉它不能再不问一句 ----

  function overlays(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>(".modal-overlay"));
  }

  it("草稿写过后点遮罩先问一句，确认才真关（R36）", () => {
    const { onClose } = renderEditor();
    fireEvent.change(fieldByLabel("Data ID"), { target: { value: "app.yaml" } });
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });

    clickOverlay(overlays()[0]);

    expect(screen.getByText("放弃未发布的内容？")).toBeInTheDocument();
    expect(screen.getByText(/配置 app\.yaml 尚未发布/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(editorTextarea().value).toBe("server:\n  port: 8080"); // 只是问，内容还在

    fireEvent.click(screen.getByRole("button", { name: "放弃内容" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("四处出口都要拦住：底部「取消」也先问", () => {
    const { onClose } = renderEditor();
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.getByText("放弃未发布的内容？")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("内容写过后点 × 也先问一句", () => {
    const { onClose } = renderEditor();
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });

    fireEvent.click(document.querySelector<HTMLButtonElement>(".modal-x")!);

    expect(screen.getByText("放弃未发布的内容？")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("什么都没写时点 × 直接关，不多问一句", () => {
    const { onClose } = renderEditor();

    fireEvent.click(document.querySelector<HTMLButtonElement>(".modal-x")!);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("放弃未发布的内容？")).not.toBeInTheDocument();
  });

  it("只改格式或分组不算脏，关编辑器不用确认", () => {
    const { onClose } = renderEditor();

    fireEvent.change(document.querySelector<HTMLInputElement>('input[value="DEFAULT_GROUP"]')!, { target: { value: "DEV_GROUP" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("放弃未发布的内容？")).not.toBeInTheDocument();
  });

  it("确认框自己的遮罩不冒泡：关掉它不会又被外层重新问一遍", () => {
    const { onClose } = renderEditor();
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });
    clickOverlay(overlays()[0]);
    expect(screen.getByText("放弃未发布的内容？")).toBeInTheDocument();

    // 第二层遮罩铺满视口，点空白处本该只关确认框、留在编辑器里继续写。
    clickOverlay(overlays()[1]);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText("放弃未发布的内容？")).not.toBeInTheDocument();
    expect(editorTextarea().value).toBe("server:\n  port: 8080");
  });

  it("Esc 走同一道闸门：先问一句，再按一次只收掉提问", () => {
    const { onClose } = renderEditor();
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("放弃未发布的内容？")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // 第二次 Esc 归确认框（分层注册表里优先级更高）：只关提问，草稿还在。
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("放弃未发布的内容？")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(editorTextarea().value).toBe("server:\n  port: 8080");

    // 想真走人还得再按一次并确认。
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "放弃内容" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("discard guard reads English in en-US", () => {
    const { onClose } = renderEditor({}, "en-US");
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });

    clickOverlay(overlays()[0]);

    expect(screen.getByText("Discard the unpublished content?")).toBeInTheDocument();
    expect(screen.getByText(/unnamed draft/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard content" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("嵌套的「放弃草稿」确认框自己成环，焦点不被外层编辑器抢走（R38）", () => {
    renderEditor();
    fireEvent.change(editorTextarea(), { target: { value: "server:\n  port: 8080" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    const inner = screen.getByRole("dialog", { name: "放弃未发布的内容？" });
    expect(inner.contains(document.activeElement)).toBe(true);

    const items = [
      ...inner.querySelectorAll<HTMLElement>(`a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])`),
    ];
    const last = items[items.length - 1];
    last.focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    last.dispatchEvent(event);
    // 由内层那层陷阱接管这一跳（外层 .modal-lg 根本收不到），焦点始终停在提问框里
    expect(event.defaultPrevented).toBe(true);
    expect(inner.contains(document.activeElement)).toBe(true);
  });
});

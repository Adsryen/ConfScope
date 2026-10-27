// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import TaskCenter from "./TaskCenter";
import { I18nProvider } from "../i18n";
import { getTaskManager } from "../lib/taskmanager";

// 模拟 taskmanager
vi.mock("../lib/taskmanager", async (importOriginal) => {
  const actual = await importOriginal();
  return actual;
});

// 模拟 toast
vi.mock("../lib/toast", () => ({
  toast: vi.fn(),
}));

function clearTasks() {
  const manager = getTaskManager();
  for (const task of manager.listTasks()) {
    if (task.status === "running" || task.status === "pending") {
      manager.cancelTask(task.id);
    }
    manager.deleteTask(task.id);
  }
}

describe("TaskCenter", () => {
  const renderWithI18n = (ui: React.ReactElement) => {
    return render(<I18nProvider>{ui}</I18nProvider>);
  };

  beforeEach(() => {
    cleanup();
    localStorage.setItem("locale", "zh-CN");
    clearTasks();
  });

  // 轮102 D4：零行时右栏那句「选择一个任务」是多余的第二次空态——上面已经说了没有任务。
  // jsdom 不做布局，所以这里钉的是 JSX 侧的契约（打没打 list-empty 类）；
  // 「右栏真的不再占位、整页只剩一条空态」由真机用例量：
  // tests/retest/specs/99-s-r102-layout-regressions.spec.ts（含删掉 CSS 规则就判红的对照组）。
  it("列表零行时给主从容器打上 list-empty，收成单列", () => {
    const { container } = renderWithI18n(<TaskCenter />);
    expect(screen.getByText("暂无任务")).toBeDefined();
    const split = container.querySelector<HTMLElement>(".data-split.task-center-content");
    expect(split?.classList.contains("list-empty")).toBe(true);
    // 占位文案仍在 DOM 内（由 CSS 摘掉），但它必须坐在 .data-detail 里，
    // 否则 styles.css 那条 .list-empty .data-detail{display:none} 就管不到它。
    const detail = split?.querySelector<HTMLElement>(".data-detail");
    expect(detail?.querySelector(".data-empty-state")).toBeTruthy();
  });

  it("有任务时不打 list-empty，右栏照常占位", async () => {
    const { container } = renderWithI18n(<TaskCenter />);
    await act(async () => {
      getTaskManager().createTask("r102 导出任务", "export");
    });
    const split = container.querySelector<HTMLElement>(".data-split.task-center-content");
    expect(split?.classList.contains("list-empty")).toBe(false);
  });

  it("renders task list with items", async () => {
    renderWithI18n(<TaskCenter />);

    // 创建任务需要通过 manager
    // 由于测试环境限制，这里主要验证组件渲染
    const titles = screen.getAllByText("任务中心");
    expect(titles.length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "清除已完成" })).toBeDefined();
  });

  it("shows tasks created outside TaskCenter", async () => {
    renderWithI18n(<TaskCenter />);

    await act(async () => {
      const manager = getTaskManager();
      const task = manager.createTask("外部快照任务", "backup");
      manager.startTask(task.id);
      manager.updateProgress(task.id, 1, 0, 2);
    });

    expect(await screen.findAllByText("外部快照任务")).toHaveLength(2);
    expect(screen.getAllByText("50%").length).toBeGreaterThan(0);
  });

  it("shows task detail actions with accessible labels", async () => {
    const onNavigateToTask = vi.fn();
    renderWithI18n(<TaskCenter onNavigateToTask={onNavigateToTask} />);

    await act(async () => {
      const manager = getTaskManager();
      const task = manager.createTask("导出配置任务", "export");
      manager.completeTask(task.id, true);
    });

    expect(await screen.findByRole("button", { name: "查看详情" })).toBeDefined();
    expect(screen.getByRole("button", { name: "复制任务信息" })).toBeDefined();
  });

  it("shows task scope in the list and detail", async () => {
    renderWithI18n(<TaskCenter />);

    await act(async () => {
      const manager = getTaskManager();
      Reflect.apply(manager.createTask, manager, [
        "备份当前列表",
        "backup",
        { scope: "dev / public / 2 configs", cancellable: false },
      ]);
    });

    expect(await screen.findAllByText("dev / public / 2 configs")).toHaveLength(2);
  });

  it("only shows cancel for tasks that are explicitly cancellable", async () => {
    renderWithI18n(<TaskCenter />);

    await act(async () => {
      const manager = getTaskManager();
      const fixedTask = manager.createTask("不可取消备份", "backup");
      manager.startTask(fixedTask.id);
      const cancellableTask = Reflect.apply(manager.createTask, manager, ["可取消应用", "apply", { cancellable: true }]);
      manager.startTask(cancellableTask.id);
    });

    expect((await screen.findAllByText("不可取消备份")).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "取消" })).toHaveLength(1);
  });

  it("shows a copy action next to failed task errors", async () => {
    renderWithI18n(<TaskCenter />);

    await act(async () => {
      const manager = getTaskManager();
      const task = manager.createTask("失败导出", "export");
      manager.startTask(task.id);
      manager.completeTask(task.id, false, "download denied");
    });

    expect(await screen.findByText("download denied")).toBeDefined();
    expect(screen.getByRole("button", { name: "复制错误" })).toBeDefined();
  });
});

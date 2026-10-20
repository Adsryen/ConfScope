/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { clearErrors, subscribeErrors, type AppErrorItem } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import type { Connection } from "../store/connections";
import type { ApplyEntryPayload } from "../lib/applyEntry";
import { loadOperationHistory } from "../store/operationHistory";
import HistoryView from "./HistoryView";

const apiMocks = vi.hoisted(() => ({
  listHistory: vi.fn(),
  getHistoryDetail: vi.fn(),
  publishConfig: vi.fn(),
}));

vi.mock("../api/nacos", async () => {
  const actual = await vi.importActual<typeof import("../api/nacos")>("../api/nacos");
  return {
    ...actual,
    listHistory: apiMocks.listHistory,
    getHistoryDetail: apiMocks.getHistoryDetail,
    publishConfig: apiMocks.publishConfig,
  };
});

vi.mock("../lib/toast", () => ({
  toast: vi.fn(),
}));

const conn: Connection = {
  id: "dev",
  name: "dev",
  baseUrl: "http://localhost:8848/nacos",
  username: "nacos",
  password: "nacos",
  defaultNamespace: "",
};

const historyItems = [
  {
    id: "2",
    dataId: "app.yaml",
    group: "DEFAULT_GROUP",
    opType: "U",
    lastModifiedTime: "2026-06-27 10:00:00",
  },
  {
    id: "1",
    dataId: "app.yaml",
    group: "DEFAULT_GROUP",
    opType: "I",
    lastModifiedTime: "2026-06-26 10:00:00",
  },
];

function renderHistory(props: Partial<Parameters<typeof HistoryView>[0]> = {}, locale = "zh-CN") {
  const onStartApply = vi.fn();
  localStorage.setItem("locale", locale);
  return {
    onStartApply,
    ...render(
      <I18nProvider>
        <HistoryView
          conn={conn}
          tenant="public"
          dataId="app.yaml"
          group="DEFAULT_GROUP"
          currentContent="server:\n  port: 9090"
          format="YAML"
          onStartApply={onStartApply}
          {...props}
        />
      </I18nProvider>
    ),
  };
}

function historyPage(items = historyItems) {
  return {
    totalCount: items.length,
    pageNumber: 1,
    pagesAvailable: 1,
    pageItems: items,
  };
}

function detail(nid: string, content: string) {
  return {
    id: nid,
    dataId: "app.yaml",
    group: "DEFAULT_GROUP",
    content,
    opType: nid === "1" ? "I" : "U",
    createdTime: "2026-06-27 10:00:00",
    lastModifiedTime: "2026-06-27 10:00:00",
  };
}

function mockHistoryDetail() {
  apiMocks.getHistoryDetail.mockImplementation(
    async (_conn: Connection, _tenant: string, _dataId: string, _group: string, nid: string) => {
      if (nid === "1") return detail("1", "server:\n  port: 8080");
      if (nid === "2") return detail("2", "server:\n  port: 9090");
      throw new Error(`missing nid ${nid}`);
    }
  );
}

function latestError(): AppErrorItem | undefined {
  let errors: AppErrorItem[] = [];
  const unsubscribe = subscribeErrors((items) => {
    errors = items;
  });
  unsubscribe();
  return errors[errors.length - 1];
}

describe("HistoryView", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
    apiMocks.listHistory.mockReset();
    apiMocks.getHistoryDetail.mockReset();
    apiMocks.publishConfig.mockReset();
    vi.mocked(toast).mockReset();
    apiMocks.listHistory.mockResolvedValue(historyPage());
    apiMocks.publishConfig.mockResolvedValue(undefined);
    mockHistoryDetail();
  });

  it("loads history and shows the empty hint before a version is selected", async () => {
    renderHistory();

    expect(await screen.findByText("nid 2")).toBeInTheDocument();
    expect(screen.getByText("nid 1")).toBeInTheDocument();
    expect(screen.getByText("历史版本（2）")).toBeInTheDocument();
    expect(screen.getByText("点击左侧版本查看内容，或勾选版本进行对比")).toBeInTheDocument();
    expect(apiMocks.listHistory).toHaveBeenCalledWith(
      conn,
      "public",
      "app.yaml",
      "DEFAULT_GROUP",
      1,
      50
    );
  });

  it("版本行键盘可达：Enter 与空格都等价于点这一行（R61）", async () => {
    const { container } = renderHistory();
    const row = await screen.findByText("nid 2");
    const main = row.closest(".history-item-main") as HTMLElement;

    expect(main).toHaveAttribute("role", "button");
    expect(main).toHaveAttribute("tabindex", "0");

    fireEvent.keyDown(main, { key: "Enter" });

    expect(await screen.findByText(/相对上一版 nid 1 的变更/)).toBeInTheDocument();
    expect(main).toHaveAttribute("aria-current", "true");

    const other = Array.from(container.querySelectorAll(".history-item-main")).find((el) => el !== main) as HTMLElement;
    fireEvent.keyDown(other, { key: " " });
    expect(other).toHaveAttribute("aria-current", "true");
    expect(main).not.toHaveAttribute("aria-current");
  });

  it("localizes history operation type labels", async () => {
    apiMocks.listHistory.mockResolvedValueOnce(
      historyPage([
        { ...historyItems[0], opType: "U" },
        { ...historyItems[1], opType: "I" },
        { ...historyItems[1], id: "0", opType: "D" },
      ])
    );

    renderHistory({}, "en-US");

    expect(await screen.findByText("Updated")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
    expect(screen.getByText("Deleted")).toBeInTheDocument();
  });

  it("opens a version and fetches its previous version for highlighted diff", async () => {
    renderHistory();

    fireEvent.click(await screen.findByText("nid 2"));

    expect(await screen.findByText(/相对上一版 nid 1 的变更/)).toBeInTheDocument();
    expect(apiMocks.getHistoryDetail).toHaveBeenCalledWith(
      conn,
      "public",
      "app.yaml",
      "DEFAULT_GROUP",
      "2"
    );
    expect(apiMocks.getHistoryDetail).toHaveBeenCalledWith(
      conn,
      "public",
      "app.yaml",
      "DEFAULT_GROUP",
      "1"
    );
    expect(await screen.findByText("~1 修改")).toBeInTheDocument();
  });

  it("compares a picked history version with current online content", async () => {
    renderHistory();

    const pickers = await screen.findAllByTitle("勾选用于对比");
    fireEvent.click(pickers[0]);

    expect(await screen.findByText(/nid 2/)).toBeInTheDocument();
    expect(screen.getByText("当前线上内容")).toBeInTheDocument();
    await waitFor(() => {
      expect(apiMocks.getHistoryDetail).toHaveBeenCalledWith(
        conn,
        "public",
        "app.yaml",
        "DEFAULT_GROUP",
        "2"
      );
    });
    expect(document.querySelector(".diff-panel")).toHaveTextContent("9090");
  });

  // 轮42 / 方案 D：回滚入口不再是「点了必失败 + 记一条假失败」，而是生成回滚变更计划。
  it("第一下只进入就地二次确认，不生成计划也不写操作历史", async () => {
    const { onStartApply } = renderHistory({ currentContent: "server:\n  port: 1000" });

    fireEvent.click(await screen.findByText("nid 2"));
    await screen.findByText(/相对上一版 nid 1/);
    fireEvent.click(screen.getByRole("button", { name: "生成回滚计划" }));

    expect(screen.getByRole("button", { name: "确认生成回滚计划" })).toBeInTheDocument();
    expect(onStartApply).not.toHaveBeenCalled();
    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    expect(loadOperationHistory()).toEqual([]);
  });

  it("hands the selected version to a rollback change plan without faking a failure", async () => {
    const { onStartApply } = renderHistory({ currentContent: "server:\n  port: 1000" }, "en-US");

    fireEvent.click(await screen.findByText("nid 2"));
    await screen.findByText(/Changes vs previous nid 1/);
    fireEvent.click(screen.getByRole("button", { name: "Generate rollback plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm rollback plan" }));

    await waitFor(() => expect(onStartApply).toHaveBeenCalledTimes(1));
    const payload = onStartApply.mock.calls[0][0] as ApplyEntryPayload;
    expect(payload).toMatchObject({ sourceType: "rollback", scope: "config" });
    expect(payload.origin?.returnMode).toBe("browse");
    expect(payload.items[0]).toMatchObject({ dataId: "app.yaml", group: "DEFAULT_GROUP", key: "__document" });
    // 来源值 = 该历史版本的正文；回滚不该把「当前线上内容」当成期望值
    expect(payload.items[0].sourceValueOverride?.content).toBe("server:\n  port: 9090");

    expect(apiMocks.publishConfig).not.toHaveBeenCalled();
    // 用户没做错事：既没有假失败记录，也不该有失败弹层/消息中心条目
    expect(loadOperationHistory()).toEqual([]);
    expect(latestError()).toBeUndefined();
    expect(toast).toHaveBeenCalledWith("Change plan created. Review and confirm it on the plan page.");
    expect(apiMocks.listHistory).toHaveBeenCalledTimes(1); // 不重新拉版本列表
  });

  it("只读连接不再挂着一个永远点不通的回滚按钮（R42-8）", async () => {
    renderHistory({ conn: { ...conn, readonly: true } });

    fireEvent.click(await screen.findByText("nid 2"));
    await screen.findByText(/相对上一版 nid 1/);
    expect(screen.queryByRole("button", { name: /回滚计划/ })).not.toBeInTheDocument();
  });

  it("读不到版本正文时仍是真错误：消息中心的重试直接重跑，不再退回二次确认", async () => {
    apiMocks.getHistoryDetail.mockImplementation(
      async (_conn: Connection, _tenant: string, _dataId: string, _group: string, nid: string) => {
        if (nid === "2") throw new Error("detail denied");
        return detail("1", "server:\n  port: 8080");
      }
    );
    const { onStartApply } = renderHistory({ currentContent: "server:\n  port: 1000" }, "en-US");

    fireEvent.click(await screen.findByText("nid 2"));
    fireEvent.click(await screen.findByRole("button", { name: "Generate rollback plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm rollback plan" }));

    expect(await screen.findByText("detail denied")).toBeInTheDocument();
    expect(onStartApply).not.toHaveBeenCalled();
    expect(loadOperationHistory()).toEqual([]);
    expect(latestError()).toMatchObject({
      title: "Failed to load history content",
      message: "detail denied",
      actionLabel: "Retry",
    });
  });

  it("reports history list errors with localized message-center actions", async () => {
    apiMocks.listHistory.mockRejectedValueOnce(new Error("history denied"));
    renderHistory({}, "en-US");

    expect(await screen.findByText("history denied")).toBeInTheDocument();
    expect(latestError()).toMatchObject({
      title: "Failed to load history versions",
      actionLabel: "Retry",
    });
  });

  it("reports history content errors with localized message-center titles", async () => {
    apiMocks.getHistoryDetail.mockRejectedValueOnce(new Error("detail denied"));
    renderHistory({}, "en-US");

    fireEvent.click(await screen.findByText("nid 2"));

    expect(await screen.findByText("detail denied")).toBeInTheDocument();
    expect(latestError()).toMatchObject({
      title: "Failed to load history content",
    });
  });

  // 轮49 R49-03 改写法：这里原本钉的是谎言——默认屏上是「高亮变更」，却要求那颗写着
  // 「原始内容」的按钮处于按下态（旧控件的文案随状态变，一颗按钮同时是标签和另一个视图的名字）。
  // 现在换成恒定命名的分段控件，按下态必须落在与在屏视图同名的那颗上，四者一起断言：
  // 文案（不随状态变）+ aria-pressed + class active + 屏上真正渲染的组件。
  it("正文视图分段控件的按下态跟着在屏视图，文案恒定（R69 / 轮49 R49-03）", async () => {
    renderHistory();
    fireEvent.click(await screen.findByText("nid 2"));

    const highlight = await screen.findByRole("button", { name: "高亮变更" });
    const raw = await screen.findByRole("button", { name: "原始内容" });
    // 默认在屏的是高亮变更，按下态与视觉态都在这颗上
    expect(highlight).toHaveAttribute("aria-pressed", "true");
    expect(highlight).toHaveClass("active");
    expect(raw).toHaveAttribute("aria-pressed", "false");
    expect(raw).not.toHaveClass("active");
    expect(document.querySelector(".udiff")).toBeTruthy();

    fireEvent.click(raw);
    // 切换后两颗名字不变（旧写法在这里会把按钮名翻成「高亮变更」，等于又造一颗谎言按钮）
    expect(await screen.findByRole("button", { name: "原始内容" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByRole("button", { name: "原始内容" })).toHaveClass("active");
    expect(await screen.findByRole("button", { name: "高亮变更" })).toHaveAttribute("aria-pressed", "false");
    expect(await screen.findByRole("button", { name: "高亮变更" })).not.toHaveClass("active");
    await waitFor(() => expect(document.querySelector(".code-area")).toBeTruthy());
    expect(document.querySelector(".udiff")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "高亮变更" }));
    await waitFor(() => expect(document.querySelector(".udiff")).toBeTruthy());
    expect(document.querySelector(".code-area")).toBeNull();
  });

  // 轮40 R40-1 / R40-3：页面级正文搜索词必须跟到「历史变更」的原文视图。
  // 缺陷长什么样（真机取证见 .trellis/tasks/10-19-ui-ux-40/prd.md）：浏览 tab 与编辑 tab 都传了词，
  // 唯独 HistoryView 的 Props 里没有 searchTerm，于是同一份内容切个 tab 红字全消失、Ctrl+F 变空串。
  // CodeView 那套（标红 / 命中行 / 定位 / 预填 / 缩略图红条）早就在，缺的只是这根 prop 线。
  it("传入页面搜索词时，「原始内容」正文出现标红与命中行（轮40 R40-1）", async () => {
    renderHistory({ searchTerm: "port" });
    fireEvent.click(await screen.findByText("nid 2"));
    fireEvent.click(await screen.findByRole("button", { name: "原始内容" }));

    await waitFor(() => expect(document.querySelectorAll(".code-area mark.search-hit").length).toBeGreaterThan(0));
    // 命中行底色层与行号层由同一份 hitSet 驱动：词到位就得跟着到位
    expect(document.querySelectorAll(".code-lines .code-line.is-hit").length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".code-gutter .code-ln.is-hit").length).toBeGreaterThan(0);
  });

  it("传入页面搜索词时，「原始内容」里按 Ctrl+F 预填该词而不是空串（轮40 R40-1）", async () => {
    renderHistory({ searchTerm: "port" });
    fireEvent.click(await screen.findByText("nid 2"));
    fireEvent.click(await screen.findByRole("button", { name: "原始内容" }));
    await waitFor(() => expect(document.querySelector(".code-area")).toBeTruthy());

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    await waitFor(() => {
      const input = document.querySelector(".code-find-input") as HTMLInputElement | null;
      expect(input?.value).toBe("port");
    });
  });

  it("不传页面搜索词时，「原始内容」一处都不标（轮40 R40-3）", async () => {
    renderHistory();
    fireEvent.click(await screen.findByText("nid 2"));
    fireEvent.click(await screen.findByRole("button", { name: "原始内容" }));
    await waitFor(() => expect(document.querySelector(".code-area")).toBeTruthy());

    // 内容里本来就有 "port"，没有词就必须一个命中都不画（防止把 dataId 搜索串误当正文词）
    expect((document.querySelector(".code-area") as HTMLElement).textContent).toContain("port");
    expect(document.querySelectorAll(".code-area mark.search-hit").length).toBe(0);
    expect(document.querySelectorAll(".code-lines .code-line.is-hit").length).toBe(0);
  });

  // 轮41 R41-1 / R41-4：默认视图（高亮变更）也必须吃到页面搜索词。
  // `rawView` 初值是 false ⇒ 用户点完历史版本看到的**第一屏**就是 UnifiedDiff，
  // 轮40 只接了「原始内容」那条分支，等于把词递到门口却没进屋（真机取证见轮41 PRD）。
  it("默认的高亮变更视图跟随页面搜索词标红，行号进命中态（轮41 R41-1）", async () => {
    renderHistory({ searchTerm: "port" });
    fireEvent.click(await screen.findByText("nid 2"));

    await waitFor(() =>
      expect(document.querySelectorAll(".diff-panel .udiff-text mark.search-hit").length).toBeGreaterThan(0)
    );
    // 命中落在 "  port: 8080"（del）与 "  port: 9090"（add）这一对上，ctx 行 "server:" 没词
    expect(document.querySelectorAll(".diff-panel .udiff-gutter.is-hit").length).toBe(2);
    // 没点「原始内容」：停在默认视图，取证前提才成立
    expect(document.querySelector(".code-area")).toBeNull();
  });

  it("不传词时默认的高亮变更视图一处都不标（轮41 R41-4）", async () => {
    renderHistory();
    fireEvent.click(await screen.findByText("nid 2"));
    await waitFor(() => expect(document.querySelector(".diff-panel")).toBeTruthy());

    const texts = Array.from(document.querySelectorAll(".udiff-text")).map((el) => el.textContent ?? "");
    expect(texts.some((line) => line.includes("port"))).toBe(true);
    expect(document.querySelectorAll(".diff-panel mark.search-hit").length).toBe(0);
    expect(document.querySelectorAll(".udiff-gutter.is-hit").length).toBe(0);
  });
});

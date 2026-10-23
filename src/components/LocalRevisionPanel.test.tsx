/**
 * @vitest-environment jsdom
 *
 * 本机版本历史面板（轮67 R57-WP15）。
 *
 * 这份测试只钉「本机这一列独有的谎言形状」：
 * - 读不出来 ≠ 还没记过（两者文案与播报角色都必须不同，混起来等于在最可疑的时刻安抚用户）；
 * - 正文没缓存的那一版不许渲染空串冒充「这一版是空的」，也不许继续挂一个永远不可能成功的回滚键；
 * - 时间列必须说清「这是本机看到的时刻」，绝不冒充配置中心的发布时间；
 * - 回滚仍是交给变更计划，不在这里写任何东西。
 * 分段控件/搜索词那几件的形状与 HistoryView 相同，由 tests/ux 的静态守卫钉，这里只跑一遍通不断线。
 */
import { fireEvent, render, screen, waitFor } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import { clearErrors, subscribeErrors, type AppErrorItem } from "../lib/errorCenter";
import { toast } from "../lib/toast";
import type { Connection } from "../store/connections";
import type { ApplyEntryPayload } from "../lib/applyEntry";
import type { ConfigRevisionRecord } from "../../wailsjs/go/app/App";
import LocalRevisionPanel from "./LocalRevisionPanel";

const revisionMocks = vi.hoisted(() => ({
  listRevisionsForKey: vi.fn(),
}));

vi.mock("../lib/configRevisions", async () => {
  const actual = await vi.importActual<typeof import("../lib/configRevisions")>("../lib/configRevisions");
  return { ...actual, listRevisionsForKey: revisionMocks.listRevisionsForKey };
});

vi.mock("../lib/toast", () => ({ toast: vi.fn() }));

const conn: Connection = {
  id: "dev",
  name: "dev",
  baseUrl: "http://localhost:8848/nacos",
  username: "nacos",
  password: "nacos",
  defaultNamespace: "",
};

/** 两条记录：下标 0 是最新（写入确认），下标 1 更旧（本机读到）。 */
function rec(patch: Partial<ConfigRevisionRecord> = {}): ConfigRevisionRecord {
  return {
    schema: 1,
    ts: "2026-10-20T10:00:00.000000Z",
    kind: "confirmed-write",
    connectionId: "dev",
    connectionName: "dev",
    provider: "nacos",
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId: "app.yaml",
    hash: "sha256:aaaa1111bbbb2222cccc3333",
    serverMd5: "",
    bytes: 20,
    format: "yaml",
    content: "server:\n  port: 9090",
    contentOmittedReason: "",
    firstSeenTs: "",
    planId: "",
    appVersion: "1.0.0",
    ...patch,
  };
}

const older = rec({
  ts: "2026-10-19T10:00:00.000000Z",
  kind: "observed",
  hash: "sha256:dddd4444eeee5555ffff6666",
  content: "server:\n  port: 8080",
});

function renderPanel(props: Partial<Parameters<typeof LocalRevisionPanel>[0]> = {}, locale = "zh-CN") {
  const onStartApply = vi.fn();
  localStorage.setItem("locale", locale);
  return {
    onStartApply,
    ...render(
      <I18nProvider>
        <LocalRevisionPanel
          conn={conn}
          tenant="public"
          dataId="app.yaml"
          group="DEFAULT_GROUP"
          currentContent="server:\n  port: 1000"
          format="YAML"
          onStartApply={onStartApply}
          {...props}
        />
      </I18nProvider>
    ),
  };
}

function latestError(): AppErrorItem | undefined {
  let errors: AppErrorItem[] = [];
  const unsubscribe = subscribeErrors((items) => {
    errors = items;
  });
  unsubscribe();
  return errors[errors.length - 1];
}

function rows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".history-item-main"));
}

describe("LocalRevisionPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
    revisionMocks.listRevisionsForKey.mockReset();
    vi.mocked(toast).mockReset();
    revisionMocks.listRevisionsForKey.mockResolvedValue([rec(), older]);
  });

  it("列表说的是「本机见过」，不是配置中心的发布时间（R6）", async () => {
    const { container } = renderPanel();

    await waitFor(() => expect(rows(container)).toHaveLength(2));
    expect(screen.getByText(/这台机器见过哪些版本/)).toBeInTheDocument();
    expect(container.textContent).toContain("本机写入");
    expect(container.textContent).toContain("本机读到");
    // 两条时刻的含义不同：写入确认不能继续顶着「首见」的说法
    const titles = Array.from(container.querySelectorAll<HTMLElement>(".op")).map((el) => el.getAttribute("title"));
    expect(titles[0]).toContain("写入并回读确认");
    expect(titles[1]).toContain("不是配置中心的发布时间");
    expect(titles[0]).not.toBe(titles[1]);
  });

  it("读不出来不是「本机还没记过」：错误另说一句话，且能被读屏打断（R57-WP14 口径）", async () => {
    revisionMocks.listRevisionsForKey.mockRejectedValueOnce(new Error("trail unreadable: permission denied"));

    renderPanel();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("trail unreadable");
    // 这一句绝不能同时出现「还没记过」——那是把故障安抚成空结果
    expect(screen.queryByText(/读到正文时才会记一版/)).not.toBeInTheDocument();
    expect(latestError()).toMatchObject({ title: "本机版本历史读取失败", actionLabel: "重试" });
    // 错误全文必须抄得走，否则用户只能截图给支持
    expect(screen.getByRole("button", { name: "复制错误" })).toBeInTheDocument();
  });

  it("真的没记过时安静地说空历史，不挂 alert", async () => {
    revisionMocks.listRevisionsForKey.mockResolvedValueOnce([]);

    renderPanel();

    expect(await screen.findByText(/读到正文时才会记一版/)).toBeInTheDocument();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(latestError()).toBeUndefined();
  });

  it("「重新读取」兜住刚读完还没落盘的竞态，再读一次而不是永远空着（R8）", async () => {
    revisionMocks.listRevisionsForKey.mockResolvedValueOnce([]);
    renderPanel();
    await screen.findByText(/读到正文时才会记一版/);
    expect(revisionMocks.listRevisionsForKey).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));

    await waitFor(() => expect(revisionMocks.listRevisionsForKey).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText(/本机写入|本机读到/)).toHaveLength(2));
  });

  it("正文超上限的那一版不渲染空正文冒充「这一版是空的」，也不挂回滚键", async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    revisionMocks.listRevisionsForKey.mockResolvedValue([
      rec({ bytes: 5_000_000, content: "", contentOmittedReason: "too-large" }),
      older,
    ]);
    // 「重新读取」在 loading 期间是 disabled 的，必须等首轮落定再点（点了没反应比红更糟）
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));

    await waitFor(() => expect(container.textContent).toContain("正文未缓存"));
    fireEvent.click(rows(container)[0]);

    expect(await screen.findByText(/超出单条上限/)).toBeInTheDocument();
    // 切到「原始内容」也不许出现正文容器：空 CodeView 就是那句假话
    fireEvent.click(screen.getByRole("button", { name: "原始内容" }));
    await waitFor(() => expect(screen.getByText(/超出单条上限/)).toBeInTheDocument());
    expect(document.querySelector(".code-area")).toBeNull();
    expect(document.querySelector(".udiff")).toBeNull();
    expect(screen.queryByRole("button", { name: "生成回滚计划" })).not.toBeInTheDocument();
  });

  it("省略原因换值时不再认旧字面量：Go 侧改了值这里就应当照旧渲染正文", async () => {
    // 反向对照：reason 为空串 ⇒ 正文照常渲染（防止把「任何非空 reason」当成省略）
    const { container } = renderPanel();
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    revisionMocks.listRevisionsForKey.mockResolvedValue([rec({ contentOmittedReason: "" }), older]);
    fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    fireEvent.click(rows(container)[0]);
    await waitFor(() => expect(document.querySelector(".udiff")).toBeTruthy());
    expect(screen.queryByText(/超出单条上限/)).not.toBeInTheDocument();
  });

  it("勾选两条本机记录互相对比，而不是拿线上内容冒充上一版", async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(rows(container)).toHaveLength(2));

    const pickers = await screen.findAllByTitle("勾选用于对比");
    fireEvent.click(pickers[0]);
    fireEvent.click(pickers[1]);

    await waitFor(() => expect(document.querySelector(".diff-panel")).toBeTruthy());
    expect(container.textContent).toContain("server:");
    expect(document.querySelector(".diff-panel")?.textContent).toMatch(/9090|8080/);
  });

  it("正文视图分段切换照常可用（与历史视图同一形状，词与 active 都接到）", async () => {
    const { container } = renderPanel();
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    fireEvent.click(rows(container)[0]);

    const highlight = await screen.findByRole("button", { name: "高亮变更" });
    expect(highlight).toHaveAttribute("aria-pressed", "true");
    expect(highlight).toHaveClass("active");
    expect(document.querySelector(".udiff")).toBeTruthy();
    expect(container.textContent).toContain("相对上一条本机记录");

    fireEvent.click(screen.getByRole("button", { name: "原始内容" }));
    await waitFor(() => expect(document.querySelector(".code-area")).toBeTruthy());
    expect(document.querySelector(".udiff")).toBeNull();
    expect(screen.getByRole("button", { name: "高亮变更" })).toHaveAttribute("aria-pressed", "false");
  });

  it("页面搜索词透传到本机历史的正文视图，红字与命中行都在（不另起第二份词）", async () => {
    const { container } = renderPanel({ searchTerm: "port" });
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    fireEvent.click(rows(container)[0]);

    await waitFor(() => expect(document.querySelectorAll(".udiff mark.search-hit").length).toBeGreaterThan(0));
    fireEvent.click(await screen.findByRole("button", { name: "原始内容" }));
    await waitFor(() => expect(document.querySelectorAll(".code-area mark.search-hit").length).toBeGreaterThan(0));
  });

  it("回滚两下确认才交给计划流程，载荷带着这一版的正文", async () => {
    const { container, onStartApply } = renderPanel();
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    fireEvent.click(rows(container)[1]);
    await screen.findByRole("button", { name: "生成回滚计划" });

    fireEvent.click(screen.getByRole("button", { name: "生成回滚计划" }));
    expect(onStartApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认生成回滚计划" }));
    await waitFor(() => expect(onStartApply).toHaveBeenCalledTimes(1));
    const payload = onStartApply.mock.calls[0][0] as ApplyEntryPayload;
    expect(payload).toMatchObject({ sourceType: "rollback", scope: "config" });
    expect(payload.items[0]).toMatchObject({ dataId: "app.yaml", group: "DEFAULT_GROUP", key: "__document" });
    expect(payload.items[0].sourceValueOverride?.content).toBe(older.content);
    expect(toast).toHaveBeenCalledWith("已生成变更计划，请在计划页确认后执行");
  });

  it("只读目标不挂回滚键：出路本来就不在这里（与历史视图同一口径）", async () => {
    const { container } = renderPanel({ conn: { ...conn, readonly: true } });
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    fireEvent.click(rows(container)[0]);

    await waitFor(() => expect(document.querySelector(".udiff")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "生成回滚计划" })).not.toBeInTheDocument();
  });

  it("切连接或切配置键时清空上一把的勾选与查看，不拿 A 键的正文显示 B 键", async () => {
    const { container, rerender } = renderPanel();
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    fireEvent.click(rows(container)[0]);
    await screen.findByText(/相对上一条本机记录/);

    rerender(
      <I18nProvider>
        <LocalRevisionPanel
          conn={conn}
          tenant="other"
          dataId="app.yaml"
          group="DEFAULT_GROUP"
          currentContent="server:\n  port: 1000"
          format="YAML"
        />
      </I18nProvider>
    );

    await waitFor(() => expect(revisionMocks.listRevisionsForKey).toHaveBeenLastCalledWith(conn, {
      namespace: "other",
      group: "DEFAULT_GROUP",
      dataId: "app.yaml",
    }));
    expect(screen.getByText(/点击左侧版本查看内容/)).toBeInTheDocument();
  });
});

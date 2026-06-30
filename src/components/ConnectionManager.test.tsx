/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import ConnectionManager from "./ConnectionManager";

const apiMocks = vi.hoisted(() => ({
  clearToken: vi.fn(),
  listNamespaces: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock("../api/nacos", () => apiMocks);

const clipboardMocks = vi.hoisted(() => ({
  copyText: vi.fn(),
}));

vi.mock("../lib/clipboard", () => clipboardMocks);

const appApiMocks = vi.hoisted(() => ({
  selectLocalSnapshotDirectory: vi.fn(),
  validateLocalSnapshotDirectory: vi.fn(),
}));

vi.mock("../api/app", () => appApiMocks);

function renderManager(onChange = vi.fn(), onClose = vi.fn()) {
  localStorage.setItem("locale", "zh-CN");
  return {
    onChange,
    onClose,
    ...render(
      <I18nProvider>
        <ConnectionManager onChange={onChange} onClose={onClose} />
      </I18nProvider>
    ),
  };
}

function fieldByLabel(label: string): HTMLInputElement {
  return screen.getByText(label).closest("label")!.querySelector("input")!;
}

function controlByLabel(label: string): HTMLInputElement | HTMLSelectElement {
  return screen.getByText(label).closest("label")!.querySelector("input, select")!;
}

function setProject(name: string) {
  const label = screen.getByText("项目").closest("label")!;
  const select = label.querySelector("select");
  if (select) {
    fireEvent.change(select, { target: { value: "__new__" } });
  }
  const input = label.querySelector("input")!;
  fireEvent.change(input, { target: { value: name } });
}

function saveConnection(fields: {
  name: string;
  project?: string;
  environment?: string;
  source?: string;
  baseUrl?: string;
}) {
  fireEvent.change(fieldByLabel("备注（可选）"), { target: { value: fields.name } });
  if (fields.project) setProject(fields.project);
  if (fields.environment) fireEvent.change(controlByLabel("环境"), { target: { value: fields.environment } });
  if (fields.source) fireEvent.change(fieldByLabel("来源名称"), { target: { value: fields.source } });
  fireEvent.change(fieldByLabel("目标地址"), {
    target: { value: fields.baseUrl ?? `http://${fields.name}.example.com/nacos` },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
}

function connectionList() {
  return screen.getByText("已保存连接").closest(".conn-list") as HTMLElement;
}

function fieldLabel(label: string): HTMLElement {
  return screen.getByText(label).closest(".field-label") as HTMLElement;
}

describe("ConnectionManager", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(Math, "random").mockReturnValue(0.123456);
    vi.setSystemTime(new Date("2026-06-27T00:00:00Z"));
    apiMocks.clearToken.mockReset();
    apiMocks.listNamespaces.mockReset();
    apiMocks.testConnection.mockReset();
    apiMocks.listNamespaces.mockResolvedValue([
      { namespace: "dev-tenant", namespaceShowName: "开发命名空间", configCount: 3, kind: 0 },
    ]);
    clipboardMocks.copyText.mockReset();
    appApiMocks.selectLocalSnapshotDirectory.mockReset();
    appApiMocks.validateLocalSnapshotDirectory.mockReset();
  });

  it("renders empty state and closes with Escape", () => {
    const onClose = vi.fn();
    renderManager(vi.fn(), onClose);

    expect(screen.getByText("连接管理")).toBeInTheDocument();
    expect(screen.getByText("暂无连接，右侧新建一个")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("saves a new connection and notifies parent", () => {
    const onChange = vi.fn();
    renderManager(onChange);

    fireEvent.change(fieldByLabel("备注（可选）"), { target: { value: "dev" } });
    fireEvent.change(fieldByLabel("来源名称"), { target: { value: "云上内网" } });
    fireEvent.change(fieldByLabel("目标地址"), {
      target: { value: "http://dev.example.com/nacos" },
    });
    fireEvent.change(fieldByLabel("用户名"), { target: { value: "nacos" } });
    fireEvent.change(fieldByLabel("密码"), { target: { value: "secret" } });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(within(connectionList()).getByText("云上内网")).toBeInTheDocument();
    expect(connectionList()).toHaveTextContent("备注: dev");
    expect(screen.getByText("http://dev.example.com/nacos")).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "dev",
        sourceName: "云上内网",
        baseUrl: "http://dev.example.com/nacos",
        username: "nacos",
        password: "secret",
      }),
    ]);
    expect(apiMocks.clearToken).toHaveBeenCalledWith(expect.stringMatching(/^c_/), "http://dev.example.com/nacos");
  });

  it("saves project environment and source metadata", () => {
    const onChange = vi.fn();
    renderManager(onChange);

    saveConnection({
      name: "prod-public",
      project: "订单系统",
      environment: "生产",
      source: "云上公网",
      baseUrl: "https://prod.example.com/nacos",
    });

    expect(within(connectionList()).getByText("订单系统")).toBeInTheDocument();
    expect(within(connectionList()).getByText("生产")).toBeInTheDocument();
    expect(within(connectionList()).getByText("云上公网")).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "prod-public",
        projectName: "订单系统",
        environmentName: "生产",
        sourceName: "云上公网",
      }),
    ]);
  });

  it("loads namespaces in the connection form and saves the selected default namespace", async () => {
    const onChange = vi.fn();
    renderManager(onChange);

    fireEvent.change(fieldByLabel("备注（可选）"), { target: { value: "dev" } });
    fireEvent.change(fieldByLabel("来源名称"), { target: { value: "云上内网" } });
    fireEvent.change(fieldByLabel("目标地址"), {
      target: { value: "http://dev.example.com/nacos" },
    });
    fireEvent.change(fieldByLabel("用户名"), { target: { value: "nacos" } });
    fireEvent.change(fieldByLabel("密码"), { target: { value: "secret" } });

    fireEvent.click(screen.getByRole("button", { name: "加载命名空间" }));

    await screen.findByRole("option", { name: "开发命名空间 / dev-tenant (3)" });
    const namespaceSelect = screen
      .getByRole("option", { name: "开发命名空间 / dev-tenant (3)" })
      .closest("select") as HTMLSelectElement;
    fireEvent.change(namespaceSelect, { target: { value: "dev-tenant" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(apiMocks.listNamespaces).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: "http://dev.example.com/nacos",
      username: "nacos",
      password: "secret",
    }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        defaultNamespace: "dev-tenant",
      }),
    ]);
  });

  it("shows saved projects in the project dropdown", () => {
    renderManager();

    saveConnection({
      name: "prod-public",
      project: "订单系统",
      environment: "生产",
      source: "云上公网",
      baseUrl: "https://prod.example.com/nacos",
    });

    fireEvent.click(screen.getByRole("button", { name: "新增来源" }));

    const project = screen.getByRole("combobox", { name: "项目" });
    expect(project).toHaveValue("订单系统");
    expect(within(project).getByRole("option", { name: "订单系统" })).toBeInTheDocument();
    expect(within(project).getByRole("option", { name: "新建项目…" })).toBeInTheDocument();
  });

  it("starts a new source under the selected environment", () => {
    renderManager();

    saveConnection({
      name: "prod-public",
      project: "订单系统",
      environment: "生产",
      source: "云上公网",
    });

    const envTitle = within(connectionList()).getByText("生产").closest(".conn-env-title") as HTMLElement;
    fireEvent.click(within(envTitle).getByTitle("新增来源"));

    expect(controlByLabel("项目").value).toBe("订单系统");
    expect(controlByLabel("环境").value).toBe("生产");
    expect(fieldByLabel("来源名称").value).toBe("");
  });

  it("uses fixed environment options", () => {
    renderManager();

    const environment = screen.getByRole("combobox", { name: "环境" });

    expect(environment).toHaveValue("开发");
    expect(within(environment).getByRole("option", { name: "开发" })).toBeInTheDocument();
    expect(within(environment).getByRole("option", { name: "测试" })).toBeInTheDocument();
    expect(within(environment).getByRole("option", { name: "预发" })).toBeInTheDocument();
    expect(within(environment).getByRole("option", { name: "生产" })).toBeInTheDocument();
    expect(within(environment).getByRole("option", { name: "灰度" })).toBeInTheDocument();
    expect(within(environment).getByRole("option", { name: "本地" })).toBeInTheDocument();
    expect(within(environment).queryByRole("option", { name: "未分组" })).not.toBeInTheDocument();
  });

  it("defaults the source entry to local snapshot for local snapshot sources", () => {
    renderManager();

    fireEvent.change(screen.getByRole("combobox", { name: "来源类型" }), {
      target: { value: "local-snapshot" },
    });

    expect(fieldByLabel("来源名称")).toHaveValue("本地快照");
    const preset = screen.getByRole("combobox", { name: "来源入口" });
    expect(preset).toHaveValue("本地快照");
    expect(within(preset).getByRole("option", { name: "本地快照" })).toBeInTheDocument();
    expect(within(preset).queryByRole("option", { name: "云上公网" })).not.toBeInTheDocument();
  });

  it("keeps a custom source name when switching to local snapshot", () => {
    renderManager();

    fireEvent.change(fieldByLabel("来源名称"), { target: { value: "生产备份-202406" } });
    fireEvent.change(screen.getByRole("combobox", { name: "来源类型" }), {
      target: { value: "local-snapshot" },
    });

    expect(fieldByLabel("来源名称")).toHaveValue("生产备份-202406");
    expect(screen.getByRole("combobox", { name: "来源入口" })).toHaveValue("");
  });

  it("marks required fields with a red asterisk", () => {
    renderManager();

    expect(within(fieldLabel("备注（可选）")).queryByText("*")).not.toBeInTheDocument();
    expect(within(fieldLabel("项目")).getByText("*")).toBeInTheDocument();
    expect(within(fieldLabel("环境")).getByText("*")).toBeInTheDocument();
    expect(within(fieldLabel("来源类型")).getByText("*")).toBeInTheDocument();
    expect(within(fieldLabel("来源名称")).getByText("*")).toBeInTheDocument();
    expect(within(fieldLabel("目标地址")).getByText("*")).toBeInTheDocument();
  });

  it("renames project inline and keeps environments fixed in the sidebar", () => {
    const onChange = vi.fn();
    renderManager(onChange);

    saveConnection({
      name: "prod-public",
      project: "订单系统",
      environment: "生产",
      source: "云上公网",
    });

    const projectTitle = within(connectionList()).getByText("订单系统").closest(".conn-group-title") as HTMLElement;
    fireEvent.click(within(projectTitle).getByTitle("重命名项目"));
    fireEvent.change(within(projectTitle).getByDisplayValue("订单系统"), { target: { value: "交易平台" } });
    fireEvent.keyDown(within(projectTitle).getByDisplayValue("交易平台"), { key: "Enter" });

    expect(within(connectionList()).getByText("交易平台")).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ projectName: "交易平台" }),
    ]);

    const envTitle = within(connectionList()).getByText("生产").closest(".conn-env-title") as HTMLElement;
    expect(within(envTitle).queryByTitle("重命名环境")).not.toBeInTheDocument();
    expect(within(connectionList()).getByText("生产")).toBeInTheDocument();
  });

  it("requires name and address before saving", () => {
    renderManager();

    fireEvent.change(fieldByLabel("备注（可选）"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByText("来源名称和目标地址不能为空")).toBeInTheDocument();
  });

  it("deletes a saved connection only after second confirmation click", () => {
    renderManager();

    fireEvent.change(fieldByLabel("备注（可选）"), { target: { value: "dev" } });
    fireEvent.change(fieldByLabel("来源名称"), { target: { value: "云上内网" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const item = within(connectionList()).getByText("云上内网").closest(".conn-item")!;
    fireEvent.click(within(item as HTMLElement).getByTitle("删除"));

    expect(within(item as HTMLElement).getByRole("button", { name: "确定要删除连接「{name}」吗？" })).toBeInTheDocument();

    fireEvent.click(within(item as HTMLElement).getByRole("button", { name: "确定要删除连接「{name}」吗？" }));

    expect(screen.queryByText("dev")).not.toBeInTheDocument();
  });

  it("shows connection test success and failure as a link trace", async () => {
    apiMocks.testConnection.mockResolvedValueOnce({
      accessToken: "token",
      tokenTtl: 18000,
      globalAdmin: true,
    });
    renderManager();

    fireEvent.change(fieldByLabel("备注（可选）"), { target: { value: "dev" } });
    fireEvent.click(screen.getByRole("button", { name: "连接测试" }));

    expect(await screen.findByText("连接测试成功")).toBeInTheDocument();
    expect(screen.getByText("连接参数检查")).toBeInTheDocument();
    expect(screen.getByText("Nacos 接口")).toBeInTheDocument();
    expect(screen.getByText("连接成功，当前账号为管理员账号。")).toBeInTheDocument();

    apiMocks.testConnection.mockRejectedValueOnce(new Error("403"));
    fireEvent.click(screen.getByRole("button", { name: "连接测试" }));

    expect(await screen.findByText("连接测试失败")).toBeInTheDocument();
    expect(screen.getByText("Error: 403")).toBeInTheDocument();
  });

  it("copies the full connection test trace", async () => {
    apiMocks.testConnection.mockRejectedValueOnce(new Error("403 forbidden"));
    clipboardMocks.copyText.mockResolvedValueOnce(true);
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "连接测试" }));
    await screen.findByText("连接测试失败");

    fireEvent.click(screen.getByRole("button", { name: "复制链路" }));

    expect(clipboardMocks.copyText).toHaveBeenCalledWith(expect.stringContaining("连接测试失败"));
    expect(clipboardMocks.copyText).toHaveBeenCalledWith(expect.stringContaining("Nacos 接口"));
    expect(clipboardMocks.copyText).toHaveBeenCalledWith(expect.stringContaining("Error: 403 forbidden"));
  });

  it("keeps full long connection test errors in the copied trace", async () => {
    const rawError = `Nacos 返回 403: ${"x".repeat(500)}`;
    apiMocks.testConnection.mockRejectedValueOnce(new Error(rawError));
    clipboardMocks.copyText.mockResolvedValueOnce(true);
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "连接测试" }));

    expect(await screen.findByText("连接测试失败")).toBeInTheDocument();
    expect(screen.getByText((text) => text.includes("Nacos 返回 403:"))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "复制链路" }));

    expect(clipboardMocks.copyText).toHaveBeenCalledWith(expect.stringContaining(rawError));
  });

  it("classifies localhost tunnel reset errors as remote-forward failures", async () => {
    const rawError = '登录请求失败: Post "http://localhost:1811/nacos/v1/auth/login": read tcp 127.0.0.1:12442->127.0.0.1:1811: wsarecv: An existing connection was forcibly closed by the remote host.';
    apiMocks.testConnection.mockRejectedValueOnce(new Error(rawError));
    clipboardMocks.copyText.mockResolvedValueOnce(true);
    renderManager();

    fireEvent.change(screen.getByRole("combobox", { name: "连接方式" }), { target: { value: "ssh" } });
    fireEvent.change(fieldByLabel("SSH 服务器地址"), { target: { value: "jump.example.com" } });
    fireEvent.change(fieldByLabel("SSH 用户名"), { target: { value: "ops" } });
    fireEvent.change(fieldByLabel("SSH 密码"), { target: { value: "ssh-secret" } });

    fireEvent.click(screen.getByRole("button", { name: "连接测试" }));

    expect(await screen.findByText("连接测试失败")).toBeInTheDocument();
    expect(screen.getByText("SSH 配置").closest(".test-trace-step")).toHaveClass("ok");
    expect(screen.getByText("本地隧道入口").closest(".test-trace-step")).toHaveClass("ok");
    expect(screen.getByText("远端目标连通性").closest(".test-trace-step")).toHaveClass("error");
    expect(screen.getByText("Nacos 接口").closest(".test-trace-step")).toHaveClass("skipped");

    fireEvent.click(screen.getByRole("button", { name: "复制链路" }));
    expect(clipboardMocks.copyText).toHaveBeenCalledWith(expect.stringContaining("远端目标连通性"));
    expect(clipboardMocks.copyText).toHaveBeenCalledWith(expect.stringContaining(rawError));
  });

  it("hides the previous connection test result after editing the tested session", async () => {
    apiMocks.testConnection.mockResolvedValueOnce({
      accessToken: "token",
      tokenTtl: 18000,
      globalAdmin: false,
    });
    renderManager();

    fireEvent.change(fieldByLabel("目标地址"), { target: { value: "http://first.example.com/nacos" } });
    fireEvent.click(screen.getByRole("button", { name: "连接测试" }));

    expect(await screen.findByText("连接测试成功")).toBeInTheDocument();

    fireEvent.change(fieldByLabel("目标地址"), { target: { value: "http://second.example.com/nacos" } });

    expect(screen.queryByText("连接测试成功")).not.toBeInTheDocument();
    expect(screen.queryByText("连接成功。")).not.toBeInTheDocument();
  });

  it("does not block a new connection test after editing the tested snapshot", async () => {
    let resolveFirst!: (value: { accessToken: string; tokenTtl: number; globalAdmin: boolean }) => void;
    apiMocks.testConnection
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({ accessToken: "token-2", tokenTtl: 18000, globalAdmin: false });
    renderManager();

    fireEvent.change(fieldByLabel("目标地址"), { target: { value: "http://first.example.com/nacos" } });
    fireEvent.click(screen.getByRole("button", { name: "连接测试" }));
    expect(screen.getByRole("button", { name: "测试中…" })).toBeDisabled();

    fireEvent.change(fieldByLabel("目标地址"), { target: { value: "http://second.example.com/nacos" } });
    fireEvent.click(screen.getByRole("button", { name: "连接测试" }));

    expect(apiMocks.testConnection).toHaveBeenCalledTimes(2);
    expect(apiMocks.testConnection).toHaveBeenNthCalledWith(1, expect.objectContaining({ baseUrl: "http://first.example.com/nacos" }));
    expect(apiMocks.testConnection).toHaveBeenNthCalledWith(2, expect.objectContaining({ baseUrl: "http://second.example.com/nacos" }));

    resolveFirst({ accessToken: "token-1", tokenTtl: 18000, globalAdmin: true });
    await waitFor(() => expect(apiMocks.testConnection).toHaveBeenCalledTimes(2));
  });

  it("saves SSH tunnel settings with the connection", async () => {
    const onChange = vi.fn();
    renderManager(onChange);

    fireEvent.change(fieldByLabel("备注（可选）"), { target: { value: "ssh-dev" } });
    fireEvent.change(fieldByLabel("来源名称"), { target: { value: "云上内网" } });
    fireEvent.change(screen.getByRole("combobox", { name: "连接方式" }), { target: { value: "ssh" } });
    fireEvent.change(fieldByLabel("SSH 服务器地址"), { target: { value: "jump.example.com" } });
    fireEvent.change(fieldByLabel("SSH 用户名"), { target: { value: "ops" } });
    fireEvent.change(fieldByLabel("SSH 密码"), { target: { value: "ssh-secret" } });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([
        expect.objectContaining({
          name: "ssh-dev",
          sourceName: "云上内网",
          sshConfig: expect.objectContaining({
            host: "jump.example.com",
            username: "ops",
            password: "ssh-secret",
          }),
        }),
      ]);
    });
    expect(screen.getByTitle("SSH 隧道")).toBeInTheDocument();
  });

  it("saves inline SSH settings as a reusable profile and references it from the connection", async () => {
    const onChange = vi.fn();
    renderManager(onChange);

    fireEvent.change(fieldByLabel("备注（可选）"), { target: { value: "ssh-dev" } });
    fireEvent.change(fieldByLabel("来源名称"), { target: { value: "云上内网" } });
    fireEvent.change(screen.getByRole("combobox", { name: "连接方式" }), { target: { value: "ssh" } });
    fireEvent.change(fieldByLabel("SSH 服务器地址"), { target: { value: "jump.example.com" } });
    fireEvent.change(fieldByLabel("SSH 用户名"), { target: { value: "ops" } });
    fireEvent.change(fieldByLabel("SSH 密码"), { target: { value: "ssh-secret" } });

    fireEvent.click(screen.getByRole("button", { name: "保存为 SSH 配置档案" }));

    expect(screen.getByText("SSH 配置档案已保存")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "SSH 配置档案" })).toHaveDisplayValue(
      "ssh-dev (ops@jump.example.com:22)"
    );

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const saved = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0][0];
    expect(saved).toEqual(expect.objectContaining({
      name: "ssh-dev",
      sourceName: "云上内网",
      sshProfileId: expect.stringMatching(/^ssh_/),
    }));
    expect(saved.sshConfig).toBeUndefined();
    expect(JSON.parse(localStorage.getItem("cs.sshProfiles") || "[]")).toEqual([
      expect.objectContaining({
        name: "ssh-dev",
        config: expect.objectContaining({
          host: "jump.example.com",
          username: "ops",
          password: "ssh-secret",
        }),
      }),
    ]);
  });

  it("saves Aliyun MSE Nacos AccessKey settings", async () => {
    const onChange = vi.fn();
    renderManager(onChange);

    fireEvent.change(fieldByLabel("备注（可选）"), { target: { value: "mse-dev" } });
    fireEvent.change(fieldByLabel("来源名称"), { target: { value: "云上公网" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Nacos 类型" }), { target: { value: "aliyun-mse" } });
    fireEvent.change(fieldByLabel("目标地址"), { target: { value: "https://mse.example.com/nacos" } });
    fireEvent.change(fieldByLabel("AccessKey ID"), { target: { value: "ak-test" } });
    fireEvent.change(fieldByLabel("AccessKey Secret"), { target: { value: "sk-test" } });
    fireEvent.change(fieldByLabel("Security Token（可选）"), { target: { value: "sts-token" } });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "mse-dev",
        sourceName: "云上公网",
        distribution: "aliyun-mse",
        authType: "aliyun-aksk",
        baseUrl: "https://mse.example.com/nacos",
        accessKeyId: "ak-test",
        accessKeySecret: "sk-test",
        securityToken: "sts-token",
      }),
    ]);
  });

  it("requires local snapshot validation before saving a local source", async () => {
    const onChange = vi.fn();
    appApiMocks.validateLocalSnapshotDirectory.mockResolvedValueOnce({
      valid: true,
      path: "C:\\backup\\order-prod",
      message: "ok",
      configCount: 2,
      hasManifest: true,
      matchedMarkers: ["manifest.json"],
      checkedAt: "2026-06-29T00:00:00Z",
    });
    renderManager(onChange);

    fireEvent.change(fieldByLabel("备注（可选）"), { target: { value: "local-prod" } });
    fireEvent.change(fieldByLabel("来源名称"), { target: { value: "本地快照" } });
    fireEvent.change(screen.getByRole("combobox", { name: "来源类型" }), {
      target: { value: "local-snapshot" },
    });
    fireEvent.change(screen.getByPlaceholderText("输入或选择本地文件夹路径"), {
      target: { value: "C:\\backup\\order-prod" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByText("请先校验本地快照目录，校验通过后再保存")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "校验目录" }));
    await waitFor(() => {
      expect(screen.getAllByText("目录有效，找到 2 个配置文件").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        name: "local-prod",
        sourceName: "本地快照",
        sourceType: "local-snapshot",
        localPath: "C:\\backup\\order-prod",
        forceLocalSnapshot: false,
        baseUrl: "C:\\backup\\order-prod",
        localValidation: expect.objectContaining({
          valid: true,
          configCount: 2,
        }),
      }),
    ]);
  });

  it("allows forcing a local snapshot folder when validation fails", async () => {
    const onChange = vi.fn();
    appApiMocks.validateLocalSnapshotDirectory.mockResolvedValueOnce({
      valid: false,
      path: "C:\\backup\\loose",
      message: "未找到快照清单或标准目录结构",
      configCount: 1,
      hasManifest: false,
      matchedMarkers: [],
      checkedAt: "2026-06-29T00:00:00Z",
    });
    renderManager(onChange);

    fireEvent.change(fieldByLabel("来源名称"), { target: { value: "临时本地目录" } });
    fireEvent.change(screen.getByRole("combobox", { name: "来源类型" }), {
      target: { value: "local-snapshot" },
    });
    fireEvent.change(screen.getByPlaceholderText("输入或选择本地文件夹路径"), {
      target: { value: "C:\\backup\\loose" },
    });
    fireEvent.click(screen.getByRole("button", { name: "校验目录" }));
    await waitFor(() => {
      expect(screen.getAllByText("未找到快照清单或标准目录结构").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByLabelText("强制使用此目录"));
    expect(screen.getByText("目录校验不通过时仍允许保存。后续读取或对比可能失败，请确认目录结构可被识别。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        sourceName: "临时本地目录",
        sourceType: "local-snapshot",
        localPath: "C:\\backup\\loose",
        forceLocalSnapshot: true,
        localValidation: expect.objectContaining({
          valid: false,
          message: "未找到快照清单或标准目录结构",
        }),
      }),
    ]);
  });

  it("validates automatically after choosing a local snapshot folder", async () => {
    appApiMocks.selectLocalSnapshotDirectory.mockResolvedValueOnce("C:\\backup\\picked-prod");
    appApiMocks.validateLocalSnapshotDirectory.mockResolvedValueOnce({
      valid: true,
      path: "C:\\backup\\picked-prod",
      message: "ok",
      configCount: 3,
      hasManifest: true,
      matchedMarkers: ["confscope.snapshot.json"],
      checkedAt: "2026-06-29T00:00:00Z",
    });
    renderManager();

    fireEvent.change(screen.getByRole("combobox", { name: "来源类型" }), {
      target: { value: "local-snapshot" },
    });
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));

    await waitFor(() => {
      expect(appApiMocks.validateLocalSnapshotDirectory).toHaveBeenCalledWith("C:\\backup\\picked-prod");
    });
    expect(screen.getByPlaceholderText("输入或选择本地文件夹路径")).toHaveValue("C:\\backup\\picked-prod");
    expect(screen.getAllByText("目录有效，找到 3 个配置文件").length).toBeGreaterThan(0);
    expect(screen.getByText("C:\\backup\\picked-prod")).toBeInTheDocument();
  });
});

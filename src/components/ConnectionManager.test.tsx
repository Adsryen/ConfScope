/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, waitFor, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import ConnectionManager from "./ConnectionManager";

const apiMocks = vi.hoisted(() => ({
  clearToken: vi.fn(),
  testConnection: vi.fn(),
}));

vi.mock("../api/nacos", () => apiMocks);

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

describe("ConnectionManager", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(Math, "random").mockReturnValue(0.123456);
    vi.setSystemTime(new Date("2026-06-27T00:00:00Z"));
    apiMocks.clearToken.mockReset();
    apiMocks.testConnection.mockReset();
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

    fireEvent.change(fieldByLabel("连接名称（标签）"), { target: { value: "dev" } });
    fireEvent.change(fieldByLabel("目标地址"), {
      target: { value: "http://dev.example.com/nacos" },
    });
    fireEvent.change(fieldByLabel("用户名"), { target: { value: "nacos" } });
    fireEvent.change(fieldByLabel("密码"), { target: { value: "secret" } });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByText("dev")).toBeInTheDocument();
    expect(screen.getByText("http://dev.example.com/nacos")).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "dev",
        baseUrl: "http://dev.example.com/nacos",
        username: "nacos",
        password: "secret",
      }),
    ]);
    expect(apiMocks.clearToken).toHaveBeenCalledWith(expect.stringMatching(/^c_/), "http://dev.example.com/nacos");
  });

  it("requires name and address before saving", () => {
    renderManager();

    fireEvent.change(fieldByLabel("连接名称（标签）"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByText("连接名称和目标地址不能为空")).toBeInTheDocument();
  });

  it("deletes a saved connection only after second confirmation click", () => {
    renderManager();

    fireEvent.change(fieldByLabel("连接名称（标签）"), { target: { value: "dev" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    const item = screen.getByText("dev").closest(".conn-item")!;
    fireEvent.click(within(item as HTMLElement).getByTitle("删除"));

    expect(within(item as HTMLElement).getByRole("button", { name: "确定要删除连接「{name}」吗？" })).toBeInTheDocument();

    fireEvent.click(within(item as HTMLElement).getByRole("button", { name: "确定要删除连接「{name}」吗？" }));

    expect(screen.queryByText("dev")).not.toBeInTheDocument();
  });

  it("shows connection test success and failure messages", async () => {
    apiMocks.testConnection.mockResolvedValueOnce({
      accessToken: "token",
      tokenTtl: 18000,
      globalAdmin: true,
    });
    renderManager();

    fireEvent.change(fieldByLabel("连接名称（标签）"), { target: { value: "dev" } });
    fireEvent.click(screen.getByRole("button", { name: "连接测试" }));

    expect(await screen.findByText("连接成功（管理员账号）")).toBeInTheDocument();

    apiMocks.testConnection.mockRejectedValueOnce(new Error("403"));
    fireEvent.click(screen.getByRole("button", { name: "连接测试" }));

    expect(await screen.findByText("Error: 403")).toBeInTheDocument();
  });

  it("saves SSH tunnel settings with the connection", async () => {
    const onChange = vi.fn();
    renderManager(onChange);

    fireEvent.change(fieldByLabel("连接名称（标签）"), { target: { value: "ssh-dev" } });
    fireEvent.click(screen.getByRole("button", { name: /SSH 隧道配置/ }));
    fireEvent.change(fieldByLabel("SSH 服务器地址"), { target: { value: "jump.example.com" } });
    fireEvent.change(fieldByLabel("SSH 用户名"), { target: { value: "ops" } });
    fireEvent.change(fieldByLabel("SSH 密码"), { target: { value: "ssh-secret" } });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([
        expect.objectContaining({
          name: "ssh-dev",
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

  it("saves Aliyun MSE Nacos AccessKey settings", async () => {
    const onChange = vi.fn();
    renderManager(onChange);

    fireEvent.change(fieldByLabel("连接名称（标签）"), { target: { value: "mse-dev" } });
    fireEvent.change(screen.getByLabelText("Nacos 类型"), { target: { value: "aliyun-mse" } });
    fireEvent.change(fieldByLabel("目标地址"), { target: { value: "https://mse.example.com/nacos" } });
    fireEvent.change(fieldByLabel("AccessKey ID"), { target: { value: "ak-test" } });
    fireEvent.change(fieldByLabel("AccessKey Secret"), { target: { value: "sk-test" } });
    fireEvent.change(fieldByLabel("Security Token（可选）"), { target: { value: "sts-token" } });

    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "mse-dev",
        distribution: "aliyun-mse",
        authType: "aliyun-aksk",
        baseUrl: "https://mse.example.com/nacos",
        accessKeyId: "ak-test",
        accessKeySecret: "sk-test",
        securityToken: "sts-token",
      }),
    ]);
  });
});

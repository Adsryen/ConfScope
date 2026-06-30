/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import SSHManagerView from "./SSHManagerView";

const goApp = vi.hoisted(() => ({
  TestSSHConnection: vi.fn(),
}));

vi.mock("../../wailsjs/go/main/App", () => goApp);

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

function renderSSHManager() {
  localStorage.setItem("locale", "zh-CN");
  return render(
    <I18nProvider>
      <SSHManagerView />
    </I18nProvider>
  );
}

function inputByLabel(label: string): HTMLInputElement {
  return screen.getByText(label).closest("label")!.querySelector("input")!;
}

describe("SSHManagerView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T00:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.123456);
    vi.stubGlobal("localStorage", new MemoryStorage());
    goApp.TestSSHConnection.mockReset();
  });

  it("creates and edits reusable SSH profiles", () => {
    renderSSHManager();

    fireEvent.change(inputByLabel("档案名称"), { target: { value: "公司堡垒机" } });
    fireEvent.change(inputByLabel("SSH 服务器地址"), { target: { value: "jump.example.com" } });
    fireEvent.change(inputByLabel("SSH 用户名"), { target: { value: "ops" } });
    fireEvent.change(inputByLabel("SSH 密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByText("SSH 配置档案已保存")).toBeInTheDocument();
    expect(screen.getAllByText("公司堡垒机").length).toBeGreaterThan(0);
    expect(screen.getByText("ops@jump.example.com:22")).toBeInTheDocument();

    fireEvent.click(screen.getAllByText("公司堡垒机")[0]);
    fireEvent.change(inputByLabel("档案名称"), { target: { value: "生产跳板机" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(JSON.parse(localStorage.getItem("cs.sshProfiles") || "[]")).toEqual([
      expect.objectContaining({
        name: "生产跳板机",
        config: expect.objectContaining({
          host: "jump.example.com",
          username: "ops",
          password: "secret",
        }),
      }),
    ]);
  });

  it("blocks deleting SSH profiles referenced by connections", () => {
    localStorage.setItem("cs.sshProfiles", JSON.stringify([
      {
        id: "ssh-prod",
        name: "生产跳板机",
        config: {
          host: "jump.example.com",
          port: 22,
          username: "ops",
          authType: "password",
          password: "secret",
        },
        createdAt: "2026-06-29T00:00:00Z",
        updatedAt: "2026-06-29T00:00:00Z",
      },
    ]));
    localStorage.setItem("cs.connections", JSON.stringify([
      {
        id: "c_prod",
        name: "prod",
        projectName: "订单系统",
        environmentName: "生产",
        sourceName: "云上内网",
        sourceType: "nacos",
        baseUrl: "http://nacos.internal:8848/nacos",
        username: "",
        password: "",
        defaultNamespace: "",
        sshProfileId: "ssh-prod",
      },
    ]));
    renderSSHManager();

    fireEvent.click(screen.getByTitle("删除"));

    expect(screen.getByText("该 SSH 配置档案正在被 1 个连接引用，不能直接删除。")).toBeInTheDocument();
    expect(screen.getByText("订单系统 / 生产 / 云上内网")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("cs.sshProfiles") || "[]")).toHaveLength(1);
  });

  it("tests SSH profiles and shows latency", async () => {
    goApp.TestSSHConnection.mockResolvedValue({ latencyMs: 42 });
    renderSSHManager();

    fireEvent.change(inputByLabel("档案名称"), { target: { value: "公司堡垒机" } });
    fireEvent.change(inputByLabel("SSH 服务器地址"), { target: { value: "jump.example.com" } });
    fireEvent.change(inputByLabel("SSH 用户名"), { target: { value: "ops" } });
    fireEvent.change(inputByLabel("SSH 密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "测试 SSH" }));

    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByText("SSH 连接成功，耗时 42ms")).toBeInTheDocument();
    expect(goApp.TestSSHConnection).toHaveBeenCalledWith(expect.objectContaining({
      host: "jump.example.com",
      username: "ops",
      password: "secret",
    }));
  });

  it("does not block a new SSH test after editing the tested snapshot", async () => {
    let resolveFirst!: (value: { latencyMs: number }) => void;
    goApp.TestSSHConnection
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce({ latencyMs: 18 });
    renderSSHManager();
    const inputs = screen.getAllByRole("textbox") as HTMLInputElement[];
    const hostInput = inputs[1];
    const usernameInput = inputs[2];
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;

    fireEvent.change(hostInput, { target: { value: "jump-a.example.com" } });
    fireEvent.change(usernameInput, { target: { value: "ops" } });
    fireEvent.change(passwordInput, { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "测试 SSH" }));
    expect(screen.getByRole("button", { name: "SSH 测试中…" })).toBeDisabled();

    fireEvent.change(hostInput, { target: { value: "jump-b.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "测试 SSH" }));

    expect(goApp.TestSSHConnection).toHaveBeenCalledTimes(2);
    expect(goApp.TestSSHConnection).toHaveBeenNthCalledWith(1, expect.objectContaining({ host: "jump-a.example.com" }));
    expect(goApp.TestSSHConnection).toHaveBeenNthCalledWith(2, expect.objectContaining({ host: "jump-b.example.com" }));

    resolveFirst({ latencyMs: 41 });
  });

  it("requires confirmation before saving referenced SSH profile changes", () => {
    localStorage.setItem("cs.sshProfiles", JSON.stringify([
      {
        id: "ssh-prod",
        name: "生产跳板机",
        config: {
          host: "jump.example.com",
          port: 22,
          username: "ops",
          authType: "password",
          password: "secret",
        },
        createdAt: "2026-06-29T00:00:00Z",
        updatedAt: "2026-06-29T00:00:00Z",
      },
    ]));
    localStorage.setItem("cs.connections", JSON.stringify([
      {
        id: "c_prod",
        name: "prod",
        projectName: "订单系统",
        environmentName: "生产",
        sourceName: "云上内网",
        sourceType: "nacos",
        baseUrl: "http://nacos.internal:8848/nacos",
        username: "",
        password: "",
        defaultNamespace: "",
        sshProfileId: "ssh-prod",
      },
    ]));
    renderSSHManager();

    fireEvent.click(screen.getByText("生产跳板机"));
    fireEvent.change(inputByLabel("SSH 服务器地址"), { target: { value: "jump-new.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByText("该 SSH 配置档案正在被 1 个连接引用，保存后这些连接会立即使用新配置。请确认影响范围后再次保存。")).toBeInTheDocument();
    expect(screen.getByText("订单系统 / 生产 / 云上内网")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("cs.sshProfiles") || "[]")[0]).toEqual(expect.objectContaining({
      config: expect.objectContaining({ host: "jump.example.com" }),
    }));

    fireEvent.click(screen.getByRole("button", { name: "确认保存" }));

    expect(screen.getByText("SSH 配置档案已保存")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("cs.sshProfiles") || "[]")[0]).toEqual(expect.objectContaining({
      config: expect.objectContaining({ host: "jump-new.example.com" }),
    }));
  });
});

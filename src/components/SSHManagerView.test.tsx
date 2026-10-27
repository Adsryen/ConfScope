/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import SSHManagerView from "./SSHManagerView";
import { loadConnections } from "../store/connections";

const goApp = vi.hoisted(() => ({
  TestSSHConnection: vi.fn(),
  ProbeSSHHostKey: vi.fn(),
  TrustSSHHostKey: vi.fn(),
}));

// 与复测桥（tests/retest/bridge/retestBinding.ts 的 ProbeSSHHostKey 向量）同一批读数：
// ED25519 出示指纹 / 变更记录里的旧指纹 / 桥用过的公钥 base64 / 记录文件路径。
const KNOWN_HOSTS_PATH = "/tmp/confscope-retest/ssh/known_hosts";
const PRESENTED_FINGERPRINT = "SHA256:3W5UxeOXUQTdn6cFDV/NCQ3cRC5oLQNOA/ukyHSIYe0";
const RECORDED_FINGERPRINT = "SHA256:111111111111111111111111111111111111111";
const KEY_BASE64 = "AAAAC3NzaC1lZDI1NTE5AAAAII169OLSMGVXq+oL8ZL3zeAUdxRAgc8eAQSXk/lrno5C";

function probeVector(status: string, host: string, port: number, extra: Record<string, string> = {}) {
  return {
    status,
    host,
    port,
    recordId: `[${host}]:${port}`,
    keyType: "ssh-ed25519",
    knownHostsPath: KNOWN_HOSTS_PATH,
    ...extra,
  };
}

/** mock 链比单个 Promise 多几跳（probe → trust → 再 probe → 拨号），逐个微任务冲刷。 */
async function flushPromises() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** 首次未知 → 确认后转 trusted 的有状态探测替身（与桥的 hk-unknown 向量同语义）。 */
function statefulUnknownProbe(trusted: Set<string>) {
  goApp.ProbeSSHHostKey.mockImplementation(async (config: { host?: unknown; port?: unknown }) => {
    const host = String(config?.host ?? "");
    const port = Number(config?.port) > 0 ? Number(config?.port) : 22;
    const recordId = `[${host}]:${port}`;
    if (trusted.has(recordId)) {
      return probeVector("trusted", host, port, { fingerprint: PRESENTED_FINGERPRINT });
    }
    return probeVector("hostKeyUnknown", host, port, {
      keyBase64: KEY_BASE64,
      fingerprint: PRESENTED_FINGERPRINT,
    });
  });
  goApp.TrustSSHHostKey.mockImplementation(async (host: string, port: number) => {
    trusted.add(`[${host}]:${port}`);
  });
}

vi.mock("../../wailsjs/go/app/App", () => goApp);

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
      <SSHManagerView connections={loadConnections()} />
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
    goApp.ProbeSSHHostKey.mockReset();
    goApp.TrustSSHHostKey.mockReset();
    // 默认裁决 trusted：既有用例全部走「探测 → 直通拨号」路径，行为与加探测前一致。
    goApp.ProbeSSHHostKey.mockImplementation(async (config: { host?: unknown; port?: unknown }) => {
      const host = String(config?.host ?? "");
      const port = Number(config?.port) > 0 ? Number(config?.port) : 22;
      return probeVector("trusted", host, port);
    });
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

  it("端口越界时禁用保存、测试连接也只给提示不发请求（R24）", () => {
    renderSSHManager();

    fireEvent.change(inputByLabel("档案名称"), { target: { value: "公司堡垒机" } });
    fireEvent.change(inputByLabel("SSH 服务器地址"), { target: { value: "jump.example.com" } });
    fireEvent.change(inputByLabel("SSH 端口"), { target: { value: "70000" } });

    expect(screen.getByRole("alert")).toHaveTextContent("SSH 端口需在 1–65535 之间（当前 70000）");
    const save = screen.getByRole("button", { name: "保存" });
    expect(save).toBeDisabled();
    expect(save.closest(".btn-guard")).toHaveAttribute("title", "SSH 端口需在 1–65535 之间（当前 70000）");

    fireEvent.click(screen.getByRole("button", { name: "测试 SSH" }));
    expect(goApp.TestSSHConnection).not.toHaveBeenCalled();
    // 行内错误之外，被点掉的「测试 SSH」还要在消息条里给同一句理由（R19 不留无解释的灰按钮）
    expect(document.querySelector(".test-msg.err")).toHaveTextContent("SSH 端口需在 1–65535 之间（当前 70000）");

    // 0 不能被数据层的 `port || 22` 悄悄夹成合法值：档案表单每次 setConfig 都过 normalizeSSHConfig，
    // 一旦回退成 || 写法，0 会变成 22、红字消失、保存重新可点
    fireEvent.change(inputByLabel("SSH 端口"), { target: { value: "0" } });
    expect(inputByLabel("SSH 端口")).toHaveValue(0);
    expect(within(inputByLabel("SSH 端口").closest("label")!).getByRole("alert")).toHaveTextContent("当前 0）");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();

    // 本地端口留空是合法的：交给系统自动分配，不能因为「空」就拦着保存
    fireEvent.change(inputByLabel("SSH 端口"), { target: { value: "22" } });
    expect(screen.getByRole("button", { name: "保存" })).not.toBeDisabled();
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

    // 探测 → 拨号比旧的直通链多一跳，按微任务个数冲刷
    await flushPromises();
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

    // 等第一次的探测裁决落地（trusted），拨号已发出（挂起在 resolveFirst 上）
    await flushPromises();

    fireEvent.change(hostInput, { target: { value: "jump-b.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "测试 SSH" }));
    // 第二次的探测也要落地，拨号才算发出
    await flushPromises();

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

  it("unknown host: shows the confirm dialog with the four facts, and only writes and dials after confirming", async () => {
    const trusted = new Set<string>();
    statefulUnknownProbe(trusted);
    goApp.TestSSHConnection.mockResolvedValue({ latencyMs: 42 });
    renderSSHManager();

    fireEvent.change(inputByLabel("档案名称"), { target: { value: "新堡垒机" } });
    fireEvent.change(inputByLabel("SSH 服务器地址"), { target: { value: "hk-unknown-1.internal" } });
    fireEvent.change(inputByLabel("SSH 端口"), { target: { value: "2223" } });
    fireEvent.change(inputByLabel("SSH 用户名"), { target: { value: "ops" } });
    fireEvent.change(inputByLabel("SSH 密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "测试 SSH" }));
    await flushPromises();

    // 弹层把四条事实摆出来：主机:端口、密钥算法、SHA256 指纹、记录文件路径
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("hk-unknown-1.internal:2223");
    expect(dialog).toHaveTextContent("ssh-ed25519");
    expect(dialog).toHaveTextContent(PRESENTED_FINGERPRINT);
    expect(dialog).toHaveTextContent(KNOWN_HOSTS_PATH);
    // 确认前不写记录、不拨号
    expect(goApp.TrustSSHHostKey).not.toHaveBeenCalled();
    expect(goApp.TestSSHConnection).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认并连接" }));
    await flushPromises();

    // 确认 = 以探测给出的身份写入记录，再走完整流程（此时探测已 trusted，直通拨号）
    expect(goApp.TrustSSHHostKey).toHaveBeenCalledWith("hk-unknown-1.internal", 2223, "ssh-ed25519", KEY_BASE64);
    expect(goApp.TestSSHConnection).toHaveBeenCalledTimes(1);
    expect(screen.getByText("SSH 连接成功，耗时 42ms")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trusted).toContain("[hk-unknown-1.internal]:2223");
  });

  it("unknown host: rejecting leaves no record, no dial, and no half-baked connection", async () => {
    const trusted = new Set<string>();
    statefulUnknownProbe(trusted);
    renderSSHManager();

    fireEvent.change(inputByLabel("档案名称"), { target: { value: "新堡垒机" } });
    fireEvent.change(inputByLabel("SSH 服务器地址"), { target: { value: "hk-unknown-2.internal" } });
    fireEvent.change(inputByLabel("SSH 端口"), { target: { value: "2223" } });
    fireEvent.change(inputByLabel("SSH 用户名"), { target: { value: "ops" } });
    fireEvent.change(inputByLabel("SSH 密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "测试 SSH" }));
    await flushPromises();

    expect(screen.getByRole("dialog")).toHaveTextContent(PRESENTED_FINGERPRINT);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await flushPromises();

    // 拒绝路径：不写记录、不拨号、弹层关闭、页面给出不建连的原因
    expect(goApp.TrustSSHHostKey).not.toHaveBeenCalled();
    expect(goApp.TestSSHConnection).not.toHaveBeenCalled();
    expect(trusted.size).toBe(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".test-msg.err")).toHaveTextContent("未信任该主机密钥，未建立连接。");
    // 测试按钮回到常态且可点，不卡在忙态
    const testButton = screen.getByRole("button", { name: "测试 SSH" });
    expect(testButton).not.toBeDisabled();
  });

  it("changed host key: hard block, facts named, and no bypass button anywhere", async () => {
    goApp.ProbeSSHHostKey.mockResolvedValue(
      probeVector("hostKeyChanged", "hk-changed-1.internal", 2223, {
        keyBase64: KEY_BASE64,
        fingerprint: PRESENTED_FINGERPRINT,
        recordFingerprint: RECORDED_FINGERPRINT,
      }),
    );
    renderSSHManager();

    fireEvent.change(inputByLabel("档案名称"), { target: { value: "变更机" } });
    fireEvent.change(inputByLabel("SSH 服务器地址"), { target: { value: "hk-changed-1.internal" } });
    fireEvent.change(inputByLabel("SSH 端口"), { target: { value: "2223" } });
    fireEvent.change(inputByLabel("SSH 用户名"), { target: { value: "ops" } });
    fireEvent.change(inputByLabel("SSH 密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "测试 SSH" }));
    await flushPromises();

    const dialog = screen.getByRole("dialog");
    // 阻断弹层点名：记录指纹、服务端现在出示的指纹、记录文件、要删的记录
    expect(dialog).toHaveTextContent(RECORDED_FINGERPRINT);
    expect(dialog).toHaveTextContent(PRESENTED_FINGERPRINT);
    expect(dialog).toHaveTextContent(KNOWN_HOSTS_PATH);
    expect(dialog).toHaveTextContent("[hk-changed-1.internal]:2223");
    // 全界面不得出现任何放行入口
    for (const label of ["仍然连接", "信任并重试", "仍要连接", "跳过校验"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
    // 确认弹层 footer 只有一个按钮（知道了 ≠ 放行）
    const footerButtons = within(dialog)
      .getAllByRole("button")
      .filter((button) => button.closest(".modal-footer"));
    expect(footerButtons).toHaveLength(1);
    // 不写记录、不拨号
    expect(goApp.TrustSSHHostKey).not.toHaveBeenCalled();
    expect(goApp.TestSSHConnection).not.toHaveBeenCalled();
    // 行内消息同样点名记录文件与记录 ID（与后端报错口径一致）
    const inline = document.querySelector(".test-msg.err");
    expect(inline).toHaveTextContent(KNOWN_HOSTS_PATH);
    expect(inline).toHaveTextContent("[hk-changed-1.internal]:2223");

    // 关掉阻断弹层后依旧没有建连
    fireEvent.click(footerButtons[0]);
    await flushPromises();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(goApp.TestSSHConnection).not.toHaveBeenCalled();
  });
});

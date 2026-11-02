/**
 * @vitest-environment jsdom
 */
/*
 * 轮145：本地快照连接的保存回显 + 表单分化。
 *
 * 用户实测的两条：改完目录点保存「跳到新建的表单」（bug1）、回去看数据「没保存成功」（bug2）。
 * 两条都在这里钉成常驻用例，另外把「只读来源不该再拿到 Nacos 那套字段」的形状也钉住。
 *
 * 与 ConnectionManager.test.tsx 分文件的原因：这里要把凭据结算换成会抛错的版本，
 * 验「密钥库炸了不能连带把保存一起吞掉」——同文件里其余用例仍要走真身，
 * 所以用 importOriginal 只替这一只函数。
 */
import { act, fireEvent, render, screen, waitFor, within } from "../test/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";
import ConnectionManager from "./ConnectionManager";
import { loadConnections } from "../store/connections";

const apiMocks = vi.hoisted(() => ({ clearToken: vi.fn(), listNamespaces: vi.fn(), testConnection: vi.fn() }));
vi.mock("../api/nacos", () => apiMocks);

const vaultMocks = vi.hoisted(() => ({
  WriteSecureSecret: vi.fn(),
  ReadSecureSecret: vi.fn(),
  DeleteSecureSecret: vi.fn(),
  WriteLargeSecret: vi.fn(),
  ReadLargeSecret: vi.fn(),
  DeleteLargeSecret: vi.fn(),
}));
vi.mock("../../wailsjs/go/app/App", () => vaultMocks);

const clipboardMocks = vi.hoisted(() => ({ copyText: vi.fn() }));
vi.mock("../lib/clipboard", () => clipboardMocks);

const appApiMocks = vi.hoisted(() => ({ selectLocalSnapshotDirectory: vi.fn(), validateLocalSnapshotDirectory: vi.fn() }));
vi.mock("../api/app", () => appApiMocks);

const secretsMocks = vi.hoisted(() => ({ settleThrows: false, settleCalls: 0 }));
vi.mock("../lib/credentialSecrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/credentialSecrets")>();
  return {
    ...actual,
    settleConnectionSecrets: async (params: Parameters<typeof actual.settleConnectionSecrets>[0]) => {
      secretsMocks.settleCalls += 1;
      if (secretsMocks.settleThrows) throw new Error("secure store exploded");
      return actual.settleConnectionSecrets(params);
    },
  };
});

function renderManager(onChange = vi.fn()) {
  localStorage.setItem("locale", "zh-CN");
  return {
    onChange,
    ...render(
      <I18nProvider>
        <ConnectionManager onChange={onChange} onClose={vi.fn()} />
      </I18nProvider>
    ),
  };
}

function seedLocalConnection(overrides: Record<string, unknown> = {}) {
  localStorage.setItem(
    "cs.connections",
    JSON.stringify([
      {
        id: "seed-local",
        name: "本地快照-订单",
        projectName: "订单系统",
        environmentName: "本地",
        sourceName: "本地快照",
        sourceType: "local-snapshot",
        provider: "local",
        localPath: "C:\\backup\\order-old",
        baseUrl: "C:\\backup\\order-old",
        defaultNamespace: "",
        username: "",
        password: "",
        writeConfirmPolicy: "always",
        localValidation: { valid: true, code: "", message: "ok", configCount: 2, checkedAt: "2026-06-29T00:00:00Z" },
        ...overrides,
      },
    ])
  );
}

function formTitle(): string {
  return (document.querySelector(".conn-form-title") as HTMLElement)?.textContent ?? "";
}

function sectionTitles(): string[] {
  return Array.from(document.querySelectorAll(".conn-section-title")).map((node) => node.textContent ?? "");
}

function banner(): HTMLElement | null {
  return document.querySelector(".conn-form .test-msg");
}

function pathInput(): HTMLInputElement {
  return screen.getByPlaceholderText("输入或选择本地文件夹路径") as HTMLInputElement;
}

function saved(): ReturnType<typeof loadConnections>[number] {
  return loadConnections()[0];
}

async function openSeed() {
  const row = within(screen.getByText("已保存连接").closest(".conn-list") as HTMLElement)
    .getByText("本地快照")
    .closest(".conn-item") as HTMLElement;
  await act(async () => {
    fireEvent.click(row);
  });
}

function mockValidated(path: string, valid = true) {
  appApiMocks.validateLocalSnapshotDirectory.mockResolvedValue({
    valid,
    path,
    message: "ok",
    configCount: 5,
    hasManifest: true,
    matchedMarkers: ["manifest.json"],
    checkedAt: "2026-06-30T00:00:00Z",
  });
}

async function clickSave() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
  });
}

describe("本地快照连接的保存与表单分化（r145）", () => {
  beforeEach(() => {
    localStorage.clear();
    secretsMocks.settleThrows = false;
    secretsMocks.settleCalls = 0;
    for (const fn of Object.values(vaultMocks)) fn.mockReset().mockRejectedValue(new Error("secure store unsupported"));
    apiMocks.clearToken.mockReset();
    apiMocks.listNamespaces.mockReset().mockResolvedValue([]);
    apiMocks.testConnection.mockReset();
    appApiMocks.selectLocalSnapshotDirectory.mockReset();
    appApiMocks.validateLocalSnapshotDirectory.mockReset();
    clipboardMocks.copyText.mockReset();
  });

  it("保存后停在编辑态：标题不翻回新建、目录留着，并播报已保存（bug1）", async () => {
    seedLocalConnection();
    mockValidated("C:\\backup\\order-new");
    const { onChange } = renderManager();
    await openSeed();
    expect(formTitle()).toBe("编辑连接");

    fireEvent.change(pathInput(), { target: { value: "C:\\backup\\order-new" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "校验目录" }));
    });
    await clickSave();

    expect(formTitle()).toBe("编辑连接");
    expect(pathInput()).toHaveValue("C:\\backup\\order-new");
    expect(saved().localPath).toBe("C:\\backup\\order-new");
    expect(saved().baseUrl).toBe("C:\\backup\\order-new");
    expect(banner()?.textContent).toContain("已保存：");
    expect(banner()?.className).toContain("ok");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("改目录后直接保存被拦下时，屏幕上必须看得见理由（bug2）", async () => {
    // 先校验成功一次，把 testResultKey 钉在旧草稿指纹上——这正是真机里「点了保存一个字都不出」的那条路径。
    seedLocalConnection();
    mockValidated("C:\\backup\\order-old");
    const { onChange } = renderManager();
    await openSeed();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "校验目录" }));
    });
    await waitFor(() => expect(document.querySelector(".local-validation.ok")?.textContent ?? "").toContain("目录有效"));

    fireEvent.change(pathInput(), { target: { value: "C:\\backup\\order-new" } });
    await clickSave();

    expect(banner()).not.toBeNull();
    expect(banner()?.textContent).toContain("请先校验本地快照目录");
    expect(saved().localPath).toBe("C:\\backup\\order-old");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("校验结果带尾部分隔符也算同一目录，保存不再被「请先校验」死拦", async () => {
    seedLocalConnection();
    mockValidated("C:\\backup\\order-new\\");
    renderManager();
    await openSeed();

    fireEvent.change(pathInput(), { target: { value: "C:\\backup\\order-new" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "校验目录" }));
    });
    await waitFor(() => expect(document.querySelector(".local-validation.ok")?.textContent ?? "").toContain("目录有效"));
    await clickSave();

    expect(saved().localPath).toBe("C:\\backup\\order-new");
    expect(banner()?.textContent).toContain("已保存：");
  });

  it("改过目录就在字段下说要重新校验，校验通过后再收回", async () => {
    seedLocalConnection();
    mockValidated("C:\\backup\\order-new");
    renderManager();
    await openSeed();

    expect(screen.queryByText(/目录改过了，重新校验通过后才能保存/)).not.toBeInTheDocument();
    fireEvent.change(pathInput(), { target: { value: "C:\\backup\\order-new" } });
    expect(screen.getByText(/目录改过了，重新校验通过后才能保存/)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "校验目录" }));
    });
    await waitFor(() => expect(screen.queryByText(/目录改过了，重新校验通过后才能保存/)).not.toBeInTheDocument());
  });

  it("本地快照表单只剩与目录有关的区块，只读来源交代替代写入确认策略", async () => {
    seedLocalConnection();
    renderManager();
    await openSeed();

    expect(sectionTitles()).toEqual(["基础信息", "快照来源"]);
    expect(screen.queryByText("安全")).not.toBeInTheDocument();
    expect(screen.queryByText("写入确认策略")).not.toBeInTheDocument();
    expect(screen.getByText(/这条来源写不回去/)).toBeInTheDocument();
    expect(screen.getByText("环境角色")).toBeInTheDocument();
    // 来源入口保留：它对本地快照仍是「一键回到默认来源名称」的入口，拆掉就少一个功能。
    expect(screen.getByRole("combobox", { name: "来源入口" })).toBeInTheDocument();
  });

  it("列表行用只读徽标交代这条来源写不回去", async () => {
    seedLocalConnection();
    renderManager();

    const row = within(screen.getByText("已保存连接").closest(".conn-list") as HTMLElement).getByText("只读");
    expect(row).toHaveAttribute("title", expect.stringContaining("写不回去"));
  });

  it("只读来源保存后不再带着写入确认策略落盘", async () => {
    seedLocalConnection();
    renderManager();
    await openSeed();
    await clickSave();

    expect(saved()).not.toHaveProperty("writeConfirmPolicy");
  });

  it("Nacos 表单的安全区块与写入确认策略照旧在（对照组）", () => {
    renderManager();

    expect(sectionTitles()).toContain("网络");
    expect(sectionTitles()).toContain("安全");
    expect(screen.getByText("写入确认策略")).toBeInTheDocument();
    expect(screen.queryByText(/这条来源写不回去/)).not.toBeInTheDocument();
  });

  it("凭据结算抛错也要把连接存下来，并说明这些字段本次是明文", async () => {
    seedLocalConnection();
    secretsMocks.settleThrows = true;
    renderManager();
    await openSeed();

    fireEvent.change(screen.getByText("备注（可选）").closest("label")!.querySelector("input")!, { target: { value: "改了备注" } });
    await clickSave();

    expect(saved().name).toBe("改了备注");
    expect(banner()?.textContent).toContain("凭据没能写入系统凭据库");
    expect(banner()?.textContent).toContain("明文");
  });

  it("连点保存只落一次盘", async () => {
    seedLocalConnection();
    mockValidated("C:\\backup\\order-new");
    const { onChange } = renderManager();
    await openSeed();
    fireEvent.change(pathInput(), { target: { value: "C:\\backup\\order-new" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "校验目录" }));
    });

    secretsMocks.settleCalls = 0;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
      fireEvent.click(screen.getByRole("button", { name: "保存" }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(secretsMocks.settleCalls).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("编辑保存后按旧目录与新目录各清一次缓存", async () => {
    seedLocalConnection();
    mockValidated("C:\\backup\\order-new");
    renderManager();
    await openSeed();
    fireEvent.change(pathInput(), { target: { value: "C:\\backup\\order-new" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "校验目录" }));
    });
    apiMocks.clearToken.mockClear();
    await clickSave();

    const cleared = apiMocks.clearToken.mock.calls.map((call) => call[1]);
    expect(cleared).toContain("C:\\backup\\order-old");
    expect(cleared).toContain("C:\\backup\\order-new");
  });
});

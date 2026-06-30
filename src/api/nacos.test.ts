/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConfig,
  getHistoryDetail,
  listConfigs,
  listHistory,
  listNamespaces,
  testConnection,
} from "./nacos";
import type { Connection } from "../store/connections";

const goApp = {
  ConfigCenterListNamespaces: vi.fn(),
  ConfigCenterListConfigs: vi.fn(),
  ConfigCenterGetConfig: vi.fn(),
  ConfigCenterPublishConfig: vi.fn(),
  ConfigCenterDeleteConfig: vi.fn(),
  ConfigCenterListHistory: vi.fn(),
  ConfigCenterGetHistoryDetail: vi.fn(),
  ConfigCenterTestConnection: vi.fn(),
  NacosDetectVersion: vi.fn(),
  NacosLogin: vi.fn(),
  NacosNamespaces: vi.fn(),
  NacosListConfigs: vi.fn(),
  NacosGetConfig: vi.fn(),
  NacosHistoryList: vi.fn(),
  NacosHistoryDetail: vi.fn(),
  NacosPublishConfig: vi.fn(),
  NacosDeleteConfig: vi.fn(),
  CreateSSHTunnel: vi.fn(),
  StopSSHTunnel: vi.fn(),
};

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

function makeConnection(id: string): Connection {
  return {
    id,
    name: "dev",
    provider: "nacos",
    distribution: "opensource",
    authType: "nacos-password",
    baseUrl: `http://127.0.0.1:8848/${id}/nacos`,
    username: "nacos",
    password: "secret",
    defaultNamespace: "public",
  };
}

function expectedProfile(conn: Connection, accessToken = "token-1", apiVersion = "v3") {
  return {
    id: conn.id,
    name: conn.name,
    provider: "nacos",
    distribution: conn.distribution,
    authType: conn.authType,
    baseUrl: conn.baseUrl,
    accessToken,
    apiVersion,
    accessKeyId: "",
    accessKeySecret: "",
    securityToken: "",
    environment: "",
    safetyLevel: "",
  };
}

function expectedRef(conn: Connection, namespace = "public", dataId = "app.yaml", group = "DEFAULT_GROUP") {
  return {
    provider: "nacos",
    connectionId: conn.id,
    namespace,
    group,
    dataId,
    key: "",
  };
}

describe("nacos api compatibility bridge", () => {
  beforeEach(() => {
    for (const fn of Object.values(goApp)) fn.mockReset();
    vi.stubGlobal("localStorage", new MemoryStorage());
    goApp.NacosDetectVersion.mockResolvedValue("v3");
    goApp.NacosLogin.mockResolvedValue({
      accessToken: "token-1",
      tokenTtl: 18000,
      globalAdmin: true,
    });
    vi.stubGlobal("go", {
      main: {
        App: goApp,
      },
    });
    vi.stubGlobal("window", {
      go: {
        main: {
          App: goApp,
        },
      },
    });
  });

  it("routes namespace reads through configCenter and keeps the old Nacos namespace shape", async () => {
    const conn = makeConnection("conn-namespaces");
    goApp.ConfigCenterListNamespaces.mockResolvedValue([
      { id: "public", name: "Public", configCount: 3, kind: 2 },
    ]);

    await expect(listNamespaces(conn)).resolves.toEqual([
      { namespace: "public", namespaceShowName: "Public", configCount: 3, kind: 2 },
    ]);

    expect(goApp.NacosDetectVersion).toHaveBeenCalledWith(conn.baseUrl);
    expect(goApp.NacosLogin).toHaveBeenCalledWith(conn.baseUrl, "nacos", "secret", "v3");
    expect(goApp.ConfigCenterListNamespaces).toHaveBeenCalledWith(expectedProfile(conn));
    expect(goApp.NacosNamespaces).not.toHaveBeenCalled();
  });

  it("routes config and history reads through configCenter while preserving old return contracts", async () => {
    const conn = makeConnection("conn-reads");
    const ref = expectedRef(conn);
    goApp.ConfigCenterListConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ ref, content: "server:\n  port: 8080", format: "yaml" }],
    });
    goApp.ConfigCenterGetConfig.mockResolvedValue({
      ref,
      content: "server:\n  port: 8080",
      format: "yaml",
      version: "42",
      source: "nacos",
    });
    goApp.ConfigCenterListHistory.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ id: "h-1", ref, opType: "U", lastModifiedTime: "1710000000000" }],
    });
    goApp.ConfigCenterGetHistoryDetail.mockResolvedValue({
      id: "h-1",
      ref,
      content: "server:\n  port: 8080",
      opType: "U",
      createdTime: "1700000000000",
      lastModifiedTime: "1710000000000",
    });

    await expect(listConfigs(conn, "public", "app.yaml", "DEFAULT_GROUP", 1, 20)).resolves.toEqual({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [
        { dataId: "app.yaml", group: "DEFAULT_GROUP", content: "server:\n  port: 8080", configType: "yaml" },
      ],
    });
    await expect(getConfig(conn, "public", "app.yaml", "DEFAULT_GROUP")).resolves.toBe("server:\n  port: 8080");
    await expect(listHistory(conn, "public", "app.yaml", "DEFAULT_GROUP", 1, 20)).resolves.toEqual({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ id: "h-1", dataId: "app.yaml", group: "DEFAULT_GROUP", opType: "U", lastModifiedTime: "1710000000000" }],
    });
    await expect(getHistoryDetail(conn, "public", "app.yaml", "DEFAULT_GROUP", "h-1")).resolves.toEqual({
      id: "h-1",
      dataId: "app.yaml",
      group: "DEFAULT_GROUP",
      content: "server:\n  port: 8080",
      opType: "U",
      createdTime: "1700000000000",
      lastModifiedTime: "1710000000000",
    });

    expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledWith(expectedProfile(conn), {
      namespace: "public",
      dataId: "app.yaml",
      group: "DEFAULT_GROUP",
      pageNo: 1,
      pageSize: 20,
    });
    expect(goApp.ConfigCenterGetConfig).toHaveBeenCalledWith(expectedProfile(conn), ref);
    expect(goApp.ConfigCenterListHistory).toHaveBeenCalledWith(expectedProfile(conn), ref, { pageNo: 1, pageSize: 20 });
    expect(goApp.ConfigCenterGetHistoryDetail).toHaveBeenCalledWith(expectedProfile(conn), ref, "h-1");
    expect(goApp.NacosListConfigs).not.toHaveBeenCalled();
    expect(goApp.NacosGetConfig).not.toHaveBeenCalled();
    expect(goApp.NacosHistoryList).not.toHaveBeenCalled();
    expect(goApp.NacosHistoryDetail).not.toHaveBeenCalled();
  });

  it("refreshes token and retries configCenter reads on 403", async () => {
    const conn = makeConnection("conn-retry");
    const ref = expectedRef(conn);
    goApp.NacosLogin
      .mockResolvedValueOnce({ accessToken: "expired-token", tokenTtl: 18000, globalAdmin: true })
      .mockResolvedValueOnce({ accessToken: "fresh-token", tokenTtl: 18000, globalAdmin: true });
    goApp.ConfigCenterGetConfig
      .mockRejectedValueOnce(new Error("code=403"))
      .mockResolvedValueOnce({ ref, content: "ok", format: "text", version: "", source: "nacos" });

    await expect(getConfig(conn, "public", "app.yaml", "DEFAULT_GROUP")).resolves.toBe("ok");

    expect(goApp.NacosLogin).toHaveBeenCalledTimes(2);
    expect(goApp.ConfigCenterGetConfig).toHaveBeenNthCalledWith(1, expectedProfile(conn, "expired-token"), ref);
    expect(goApp.ConfigCenterGetConfig).toHaveBeenNthCalledWith(2, expectedProfile(conn, "fresh-token"), ref);
  });

  it("tests Aliyun MSE Nacos connections through configCenter without Nacos password login", async () => {
    const conn: Connection = {
      ...makeConnection("conn-mse-test"),
      distribution: "aliyun-mse",
      authType: "aliyun-aksk",
      username: "",
      password: "",
      accessKeyId: "ak-test",
      accessKeySecret: "sk-test",
      securityToken: "sts-token",
    };
    goApp.ConfigCenterTestConnection.mockResolvedValue(undefined);

    await expect(testConnection(conn)).resolves.toEqual({ accessToken: "", tokenTtl: 0, globalAdmin: false });

    expect(goApp.NacosLogin).not.toHaveBeenCalled();
    expect(goApp.ConfigCenterTestConnection).toHaveBeenCalledWith({
      ...expectedProfile(conn, "", "v1"),
      distribution: "aliyun-mse",
      authType: "aliyun-aksk",
      accessKeyId: "ak-test",
      accessKeySecret: "sk-test",
      securityToken: "sts-token",
    });
    expect(goApp.NacosDetectVersion).not.toHaveBeenCalled();
  });

  it("routes local snapshot sources through the local provider without Nacos auth", async () => {
    const conn: Connection = {
      ...makeConnection("conn-local"),
      name: "local-prod",
      sourceType: "local-snapshot",
      localPath: "C:\\backup\\prod",
      baseUrl: "C:\\backup\\prod",
      username: "",
      password: "",
    };
    const localProfile = {
      ...expectedProfile(conn, "", "v1"),
      provider: "local",
      authType: "none",
      baseUrl: "C:\\backup\\prod",
    };
    const ref = {
      ...expectedRef(conn, "", "app.yaml", "DEFAULT_GROUP"),
      provider: "local",
    };
    goApp.ConfigCenterListNamespaces.mockResolvedValue([
      { id: "", name: "public", configCount: 1, kind: 0 },
    ]);
    goApp.ConfigCenterListConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ ref, content: "a: 1", format: "yaml" }],
    });
    goApp.ConfigCenterGetConfig.mockResolvedValue({
      ref,
      content: "a: 1",
      format: "yaml",
      version: "",
      source: "C:\\backup\\prod\\configs\\public\\DEFAULT_GROUP\\app.yaml",
    });
    goApp.ConfigCenterTestConnection.mockResolvedValue(undefined);

    await expect(listNamespaces(conn)).resolves.toEqual([
      { namespace: "", namespaceShowName: "public", configCount: 1, kind: 0 },
    ]);
    await expect(listConfigs(conn, "", "", "DEFAULT_GROUP", 1, 20)).resolves.toEqual({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", content: "a: 1", configType: "yaml" }],
    });
    await expect(getConfig(conn, "", "app.yaml", "DEFAULT_GROUP")).resolves.toBe("a: 1");
    await expect(testConnection(conn)).resolves.toEqual({ accessToken: "", tokenTtl: 0, globalAdmin: false });

    expect(goApp.NacosDetectVersion).not.toHaveBeenCalled();
    expect(goApp.NacosLogin).not.toHaveBeenCalled();
    expect(goApp.CreateSSHTunnel).not.toHaveBeenCalled();
    expect(goApp.ConfigCenterListNamespaces).toHaveBeenCalledWith(localProfile);
    expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledWith(localProfile, {
      namespace: "",
      dataId: "",
      group: "DEFAULT_GROUP",
      pageNo: 1,
      pageSize: 20,
    });
    expect(goApp.ConfigCenterGetConfig).toHaveBeenCalledWith(localProfile, ref);
    expect(goApp.ConfigCenterTestConnection).toHaveBeenCalledWith(localProfile);
  });

  it("derives SSH tunnel target from the Nacos base URL", async () => {
    const conn: Connection = {
      ...makeConnection("conn-ssh-derived"),
      baseUrl: "http://nacos.internal:8845/nacos",
      sshConfig: {
        host: "jump.example.com",
        port: 37380,
        username: "root",
        authType: "password",
        password: "ssh-secret",
        remoteHost: "legacy.example.com",
        remotePort: 9999,
      },
    };
    goApp.CreateSSHTunnel.mockResolvedValue(12875);
    goApp.ConfigCenterListNamespaces.mockResolvedValue([]);

    await expect(listNamespaces(conn)).resolves.toEqual([]);

    expect(goApp.CreateSSHTunnel).toHaveBeenCalledWith(
      conn.id,
      expect.objectContaining({
        host: "jump.example.com",
        port: 37380,
        remoteHost: "nacos.internal",
        remotePort: 8845,
      })
    );
    expect(goApp.ConfigCenterListNamespaces).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://localhost:12875/nacos" })
    );
  });

  it("uses reusable SSH profiles when resolving tunnels", async () => {
    localStorage.setItem("cs.sshProfiles", JSON.stringify([
      {
        id: "ssh-prod",
        name: "生产跳板机",
        config: {
          host: "prod-jump.example.com",
          port: 2222,
          username: "deploy",
          authType: "password",
          password: "profile-secret",
        },
        createdAt: "2026-06-29T00:00:00Z",
        updatedAt: "2026-06-29T00:00:00Z",
      },
    ]));
    const conn: Connection = {
      ...makeConnection("conn-ssh-profile"),
      baseUrl: "http://nacos.internal:8848/nacos",
      sshProfileId: "ssh-prod",
      sshConfig: {
        host: "inline.example.com",
        port: 22,
        username: "root",
        authType: "password",
        password: "inline-secret",
      },
    };
    goApp.CreateSSHTunnel.mockResolvedValue(13001);
    goApp.ConfigCenterListNamespaces.mockResolvedValue([]);

    await expect(listNamespaces(conn)).resolves.toEqual([]);

    expect(goApp.CreateSSHTunnel).toHaveBeenCalledWith(
      conn.id,
      expect.objectContaining({
        host: "prod-jump.example.com",
        port: 2222,
        username: "deploy",
        password: "profile-secret",
        remoteHost: "nacos.internal",
        remotePort: 8848,
      })
    );
  });

  it("normalizes protocol-less Nacos URLs before creating SSH tunnels", async () => {
    const conn: Connection = {
      ...makeConnection("conn-ssh-protocol-less"),
      baseUrl: "mse-5d1d31013-nacos-ans.mse.aliyuncs.com:8848/nacos",
      distribution: "aliyun-mse",
      authType: "aliyun-aksk",
      username: "",
      password: "",
      accessKeyId: "ak-test",
      accessKeySecret: "sk-test",
      sshConfig: {
        host: "jump.example.com",
        port: 22,
        username: "ops",
        authType: "password",
        password: "secret",
      },
    };
    goApp.CreateSSHTunnel.mockResolvedValue(13380);
    goApp.ConfigCenterTestConnection.mockResolvedValue(undefined);

    await expect(testConnection(conn)).resolves.toEqual({ accessToken: "", tokenTtl: 0, globalAdmin: false });

    expect(goApp.CreateSSHTunnel).toHaveBeenCalledWith(
      conn.id,
      expect.objectContaining({
        remoteHost: "mse-5d1d31013-nacos-ans.mse.aliyuncs.com",
        remotePort: 8848,
      })
    );
    expect(goApp.ConfigCenterTestConnection).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://localhost:13380/nacos" })
    );
  });
});

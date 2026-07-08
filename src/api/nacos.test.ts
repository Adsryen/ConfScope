/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConfig,
  getConfigDocument,
  getHistoryDetail,
  deleteConfig,
  deleteConfigFromApplyPlan,
  listConfigs,
  listHistory,
  listNamespaces,
  publishConfig,
  publishConfigFromApplyPlan,
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
  NacosPublishConfigFromApplyPlan: vi.fn(),
  NacosDeleteConfigFromApplyPlan: vi.fn(),
  CreateSSHTunnel: vi.fn(),
  StopSSHTunnel: vi.fn(),
  ReadSecureSecret: vi.fn(),
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
    accessKeyId: conn.accessKeyId ?? "",
    accessKeySecret: conn.accessKeySecret ?? "",
    securityToken: conn.securityToken ?? "",
    environment: "",
    safetyLevel: "",
    useProxy: false,
    apolloEnv: "",
    apolloAppId: "",
    apolloCluster: "",
    apolloNamespaceName: "",
    consulDatacenter: "",
    consulKeyPrefix: "",
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
    goApp.ReadSecureSecret.mockImplementation(async (ref: { field: string }) => `stored-${ref.field}`);
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
    goApp.ConfigCenterListNamespaces.mockResolvedValue([{ id: "public", name: "Public", configCount: 3, kind: 2 }]);

    await expect(listNamespaces(conn)).resolves.toEqual([{ namespace: "public", namespaceShowName: "Public", configCount: 3, kind: 2 }]);

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
      pageItems: [{ ref, content: "server:\n  port: 8080", format: "yaml", updateTime: "2026-07-06T10:00:00Z" }],
    });
    goApp.ConfigCenterGetConfig.mockResolvedValue({
      ref,
      content: "server:\n  port: 8080",
      format: "yaml",
      version: "42",
      source: "nacos",
      updateTime: "2026-07-06T10:00:00Z",
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
        {
          dataId: "app.yaml",
          group: "DEFAULT_GROUP",
          content: "server:\n  port: 8080",
          configType: "yaml",
          updateTime: "2026-07-06T10:00:00Z",
        },
      ],
    });
    await expect(getConfig(conn, "public", "app.yaml", "DEFAULT_GROUP")).resolves.toBe("server:\n  port: 8080");
    await expect(getConfigDocument(conn, "public", "app.yaml", "DEFAULT_GROUP")).resolves.toEqual({
      content: "server:\n  port: 8080",
      format: "yaml",
      version: "42",
      source: "nacos",
      updateTime: "2026-07-06T10:00:00Z",
    });
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
    expect(goApp.ConfigCenterGetConfig).toHaveBeenCalledTimes(2);
    expect(goApp.ConfigCenterGetConfig).toHaveBeenCalledWith(expectedProfile(conn), ref);
    expect(goApp.ConfigCenterListHistory).toHaveBeenCalledWith(expectedProfile(conn), ref, { pageNo: 1, pageSize: 20 });
    expect(goApp.ConfigCenterGetHistoryDetail).toHaveBeenCalledWith(expectedProfile(conn), ref, "h-1");
    expect(goApp.NacosListConfigs).not.toHaveBeenCalled();
    expect(goApp.NacosGetConfig).not.toHaveBeenCalled();
    expect(goApp.NacosHistoryList).not.toHaveBeenCalled();
    expect(goApp.NacosHistoryDetail).not.toHaveBeenCalled();
  });

  it("defaults empty MSE config-list group to DEFAULT_GROUP for signature compatibility", async () => {
    const conn: Connection = {
      ...makeConnection("conn-mse-list"),
      distribution: "aliyun-mse",
      authType: "aliyun-aksk",
      username: "",
      password: "",
      accessKeyId: "ak-test",
      accessKeySecret: "sk-test",
    };
    const ref = expectedRef(conn, "ns-a", "app.yaml", "DEFAULT_GROUP");
    goApp.ConfigCenterListConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ ref, content: "", format: "yaml" }],
    });

    await listConfigs(conn, "ns-a", "", "", 1, 50);

    expect(goApp.NacosLogin).not.toHaveBeenCalled();
    expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledWith(expectedProfile(conn, "", "v1"), {
      namespace: "ns-a",
      dataId: "",
      group: "DEFAULT_GROUP",
      pageNo: 1,
      pageSize: 50,
    });
  });

  it("refreshes token and retries configCenter reads on 403", async () => {
    const conn = makeConnection("conn-retry");
    const ref = expectedRef(conn);
    goApp.NacosLogin.mockResolvedValueOnce({ accessToken: "expired-token", tokenTtl: 18000, globalAdmin: true }).mockResolvedValueOnce({
      accessToken: "fresh-token",
      tokenTtl: 18000,
      globalAdmin: true,
    });
    goApp.ConfigCenterGetConfig.mockRejectedValueOnce(new Error("code=403")).mockResolvedValueOnce({
      ref,
      content: "ok",
      format: "text",
      version: "",
      source: "nacos",
    });

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

  it("hydrates migrated Nacos and MSE credentials before calling backend bindings", async () => {
    const passwordConn: Connection = {
      ...makeConnection("conn-secretref-password"),
      password: "",
      secretRefs: {
        password: {
          ref: "connection.conn-secretref-password.password",
          namespace: "connection",
          ownerId: "conn-secretref-password",
          field: "password",
          migratedAt: "2026-07-08T00:00:00.000Z",
          status: "stored",
        },
      },
    };
    const mseConn: Connection = {
      ...makeConnection("conn-secretref-mse"),
      distribution: "aliyun-mse",
      authType: "aliyun-aksk",
      username: "",
      password: "",
      accessKeyId: "",
      accessKeySecret: "",
      securityToken: "",
      secretRefs: {
        accessKeyId: {
          ref: "connection.conn-secretref-mse.accessKeyId",
          namespace: "connection",
          ownerId: "conn-secretref-mse",
          field: "accessKeyId",
          migratedAt: "2026-07-08T00:00:00.000Z",
          status: "stored",
        },
        accessKeySecret: {
          ref: "connection.conn-secretref-mse.accessKeySecret",
          namespace: "connection",
          ownerId: "conn-secretref-mse",
          field: "accessKeySecret",
          migratedAt: "2026-07-08T00:00:00.000Z",
          status: "stored",
        },
        securityToken: {
          ref: "connection.conn-secretref-mse.securityToken",
          namespace: "connection",
          ownerId: "conn-secretref-mse",
          field: "securityToken",
          migratedAt: "2026-07-08T00:00:00.000Z",
          status: "stored",
        },
      },
    };
    goApp.ConfigCenterListNamespaces.mockResolvedValue([]);
    goApp.ConfigCenterTestConnection.mockResolvedValue(undefined);

    await expect(listNamespaces(passwordConn)).resolves.toEqual([]);
    await expect(testConnection(mseConn)).resolves.toEqual({ accessToken: "", tokenTtl: 0, globalAdmin: false });

    expect(goApp.NacosLogin).toHaveBeenCalledWith(passwordConn.baseUrl, "nacos", "stored-password", "v3");
    expect(goApp.ConfigCenterTestConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        accessKeyId: "stored-accessKeyId",
        accessKeySecret: "stored-accessKeySecret",
        securityToken: "stored-securityToken",
      })
    );
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
    goApp.ConfigCenterListNamespaces.mockResolvedValue([{ id: "", name: "public", configCount: 1, kind: 0 }]);
    goApp.ConfigCenterListConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ ref, content: "a: 1", format: "yaml", updateTime: "2026-07-06T10:00:00Z" }],
    });
    goApp.ConfigCenterGetConfig.mockResolvedValue({
      ref,
      content: "a: 1",
      format: "yaml",
      version: "snap-1",
      source: "C:\\backup\\prod\\configs\\public\\DEFAULT_GROUP\\app.yaml",
      updateTime: "2026-07-06T10:00:00Z",
    });
    goApp.ConfigCenterTestConnection.mockResolvedValue(undefined);

    await expect(listNamespaces(conn)).resolves.toEqual([{ namespace: "", namespaceShowName: "public", configCount: 1, kind: 0 }]);
    await expect(listConfigs(conn, "", "", "DEFAULT_GROUP", 1, 20)).resolves.toEqual({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ dataId: "app.yaml", group: "DEFAULT_GROUP", content: "a: 1", configType: "yaml", updateTime: "2026-07-06T10:00:00Z" }],
    });
    await expect(getConfig(conn, "", "app.yaml", "DEFAULT_GROUP")).resolves.toBe("a: 1");
    await expect(getConfigDocument(conn, "", "app.yaml", "DEFAULT_GROUP")).resolves.toEqual({
      content: "a: 1",
      format: "yaml",
      version: "snap-1",
      source: "C:\\backup\\prod\\configs\\public\\DEFAULT_GROUP\\app.yaml",
      updateTime: "2026-07-06T10:00:00Z",
    });
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
    expect(goApp.ConfigCenterGetConfig).toHaveBeenCalledTimes(2);
    expect(goApp.ConfigCenterGetConfig).toHaveBeenCalledWith(localProfile, ref);
    expect(goApp.ConfigCenterTestConnection).toHaveBeenCalledWith(localProfile);
  });

  it("routes Apollo connections through configCenter with Apollo profile fields and token", async () => {
    const conn: Connection = {
      ...makeConnection("conn-apollo"),
      provider: "apollo",
      baseUrl: "http://127.0.0.1:8070",
      username: "",
      password: "",
      defaultNamespace: "order-service",
      apolloEnv: "DEV",
      apolloAppId: "order-service",
      apolloCluster: "default",
      apolloNamespaceName: "application",
      apolloToken: "apollo-token",
    };
    const profile = {
      ...expectedProfile(conn, "apollo-token", ""),
      provider: "apollo",
      authType: "none",
      apolloEnv: "DEV",
      apolloAppId: "order-service",
      apolloCluster: "default",
      apolloNamespaceName: "application",
    };
    const ref = {
      ...expectedRef(conn, "order-service", "application", "default"),
      provider: "apollo",
    };
    goApp.ConfigCenterListNamespaces.mockResolvedValue([
      { id: "order-service", name: "order-service / DEV / default", configCount: 1, kind: 0 },
    ]);
    goApp.ConfigCenterListConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ ref, content: "", format: "properties", updateTime: "2026-07-07T10:00:00+08:00" }],
    });
    goApp.ConfigCenterGetConfig.mockResolvedValue({
      ref,
      content: "server.port=8080\n",
      format: "properties",
      version: "release-1",
      source: "apollo:DEV/order-service/default/application",
      updateTime: "2026-07-07T10:00:00+08:00",
    });
    goApp.ConfigCenterTestConnection.mockResolvedValue(undefined);

    await expect(testConnection(conn)).resolves.toEqual({ accessToken: "", tokenTtl: 0, globalAdmin: false });
    await expect(listNamespaces(conn)).resolves.toEqual([
      { namespace: "order-service", namespaceShowName: "order-service / DEV / default", configCount: 1, kind: 0 },
    ]);
    await expect(listConfigs(conn, "order-service", "", "", 1, 20)).resolves.toEqual({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [
        { dataId: "application", group: "default", content: "", configType: "properties", updateTime: "2026-07-07T10:00:00+08:00" },
      ],
    });
    await expect(getConfig(conn, "order-service", "application", "default")).resolves.toBe("server.port=8080\n");

    expect(goApp.NacosDetectVersion).not.toHaveBeenCalled();
    expect(goApp.NacosLogin).not.toHaveBeenCalled();
    expect(goApp.ConfigCenterTestConnection).toHaveBeenCalledWith(profile);
    expect(goApp.ConfigCenterListNamespaces).toHaveBeenCalledWith(profile);
    expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledWith(profile, {
      namespace: "order-service",
      dataId: "",
      group: "default",
      pageNo: 1,
      pageSize: 20,
    });
    expect(goApp.ConfigCenterGetConfig).toHaveBeenCalledWith(profile, ref);
  });

  it("hydrates migrated Apollo and Consul tokens before building provider profiles", async () => {
    const apolloConn: Connection = {
      ...makeConnection("conn-secretref-apollo"),
      provider: "apollo",
      baseUrl: "http://127.0.0.1:8070",
      username: "",
      password: "",
      defaultNamespace: "order-service",
      apolloEnv: "DEV",
      apolloAppId: "order-service",
      apolloCluster: "default",
      apolloNamespaceName: "application",
      apolloToken: "",
      secretRefs: {
        apolloToken: {
          ref: "connection.conn-secretref-apollo.apolloToken",
          namespace: "connection",
          ownerId: "conn-secretref-apollo",
          field: "apolloToken",
          migratedAt: "2026-07-08T00:00:00.000Z",
          status: "stored",
        },
      },
    };
    const consulConn: Connection = {
      ...makeConnection("conn-secretref-consul"),
      provider: "consul",
      baseUrl: "http://127.0.0.1:8500",
      username: "",
      password: "",
      defaultNamespace: "dc1",
      consulToken: "",
      consulDatacenter: "dc1",
      consulKeyPrefix: "apps/order/",
      secretRefs: {
        consulToken: {
          ref: "connection.conn-secretref-consul.consulToken",
          namespace: "connection",
          ownerId: "conn-secretref-consul",
          field: "consulToken",
          migratedAt: "2026-07-08T00:00:00.000Z",
          status: "stored",
        },
      },
    };
    goApp.ConfigCenterTestConnection.mockResolvedValue(undefined);

    await expect(testConnection(apolloConn)).resolves.toEqual({ accessToken: "", tokenTtl: 0, globalAdmin: false });
    await expect(testConnection(consulConn)).resolves.toEqual({ accessToken: "", tokenTtl: 0, globalAdmin: false });

    expect(goApp.ConfigCenterTestConnection).toHaveBeenCalledWith(expect.objectContaining({ provider: "apollo", accessToken: "stored-apolloToken" }));
    expect(goApp.ConfigCenterTestConnection).toHaveBeenCalledWith(expect.objectContaining({ provider: "consul", accessToken: "stored-consulToken" }));
  });

  it("maps generic DEFAULT_GROUP inputs to Apollo cluster for diff and audit flows", async () => {
    const conn: Connection = {
      ...makeConnection("conn-apollo-default-group"),
      provider: "apollo",
      baseUrl: "http://127.0.0.1:8070",
      username: "",
      password: "",
      defaultNamespace: "order-service",
      apolloEnv: "DEV",
      apolloAppId: "order-service",
      apolloCluster: "default",
      apolloNamespaceName: "application",
      apolloToken: "apollo-token",
    };
    const profile = {
      ...expectedProfile(conn, "apollo-token", ""),
      provider: "apollo",
      authType: "none",
      apolloEnv: "DEV",
      apolloAppId: "order-service",
      apolloCluster: "default",
      apolloNamespaceName: "application",
    };
    const ref = {
      ...expectedRef(conn, "order-service", "application", "default"),
      provider: "apollo",
    };
    goApp.ConfigCenterListConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ ref, content: "", format: "properties", updateTime: "" }],
    });
    goApp.ConfigCenterGetConfig.mockResolvedValue({
      ref,
      content: "feature.enabled=true\n",
      format: "properties",
      version: "",
      source: "",
      updateTime: "",
    });

    await listConfigs(conn, "order-service", "", "DEFAULT_GROUP", 1, 20);
    await getConfig(conn, "order-service", "application", "DEFAULT_GROUP");

    expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledWith(profile, {
      namespace: "order-service",
      dataId: "",
      group: "default",
      pageNo: 1,
      pageSize: 20,
    });
    expect(goApp.ConfigCenterGetConfig).toHaveBeenCalledWith(profile, ref);
  });

  it("routes Consul connections through configCenter with token and KV prefix fields", async () => {
    const conn: Connection = {
      ...makeConnection("conn-consul"),
      provider: "consul",
      baseUrl: "http://127.0.0.1:8500",
      username: "",
      password: "",
      defaultNamespace: "dc1",
      consulToken: "consul-token",
      consulDatacenter: "dc1",
      consulKeyPrefix: "apps/order/",
    };
    const profile = {
      ...expectedProfile(conn, "consul-token", ""),
      provider: "consul",
      authType: "none",
      consulDatacenter: "dc1",
      consulKeyPrefix: "apps/order/",
    };
    const ref = {
      ...expectedRef(conn, "dc1", "apps/order/app.yaml", "apps/order/"),
      provider: "consul",
    };
    goApp.ConfigCenterListNamespaces.mockResolvedValue([{ id: "dc1", name: "dc1", configCount: 0, kind: 0 }]);
    goApp.ConfigCenterListConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ ref, content: "server:\n  port: 8080\n", format: "yaml", updateTime: "42" }],
    });
    goApp.ConfigCenterGetConfig.mockResolvedValue({
      ref,
      content: "server:\n  port: 8080\n",
      format: "yaml",
      version: "42",
      source: "consul:dc1/apps/order/app.yaml",
      updateTime: "42",
    });
    goApp.ConfigCenterTestConnection.mockResolvedValue(undefined);

    await expect(testConnection(conn)).resolves.toEqual({ accessToken: "", tokenTtl: 0, globalAdmin: false });
    await expect(listNamespaces(conn)).resolves.toEqual([{ namespace: "dc1", namespaceShowName: "dc1", configCount: 0, kind: 0 }]);
    await expect(listConfigs(conn, "dc1", "", "apps/order/", 1, 20)).resolves.toEqual({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ dataId: "apps/order/app.yaml", group: "apps/order/", content: "server:\n  port: 8080\n", configType: "yaml", updateTime: "42" }],
    });
    await expect(getConfig(conn, "dc1", "apps/order/app.yaml", "apps/order/")).resolves.toBe("server:\n  port: 8080\n");

    expect(goApp.NacosDetectVersion).not.toHaveBeenCalled();
    expect(goApp.NacosLogin).not.toHaveBeenCalled();
    expect(goApp.ConfigCenterTestConnection).toHaveBeenCalledWith(profile);
    expect(goApp.ConfigCenterListNamespaces).toHaveBeenCalledWith(profile);
    expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledWith(profile, {
      namespace: "dc1",
      dataId: "",
      group: "apps/order/",
      pageNo: 1,
      pageSize: 20,
    });
    expect(goApp.ConfigCenterGetConfig).toHaveBeenCalledWith(profile, ref);
  });

  it("maps generic DEFAULT_GROUP inputs to Consul key prefix for diff and audit flows", async () => {
    const conn: Connection = {
      ...makeConnection("conn-consul-default-group"),
      provider: "consul",
      baseUrl: "http://127.0.0.1:8500",
      username: "",
      password: "",
      defaultNamespace: "dc1",
      consulToken: "consul-token",
      consulDatacenter: "dc1",
      consulKeyPrefix: "apps/order/",
    };
    const profile = {
      ...expectedProfile(conn, "consul-token", ""),
      provider: "consul",
      authType: "none",
      consulDatacenter: "dc1",
      consulKeyPrefix: "apps/order/",
    };
    const ref = {
      ...expectedRef(conn, "dc1", "apps/order/app.yaml", "apps/order/"),
      provider: "consul",
    };
    goApp.ConfigCenterListConfigs.mockResolvedValue({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [{ ref, content: "server:\n  port: 8080\n", format: "yaml", updateTime: "42" }],
    });
    goApp.ConfigCenterGetConfig.mockResolvedValue({
      ref,
      content: "server:\n  port: 8080\n",
      format: "yaml",
      version: "42",
      source: "consul:dc1/apps/order/app.yaml",
      updateTime: "42",
    });

    await listConfigs(conn, "dc1", "", "DEFAULT_GROUP", 1, 20);
    await getConfig(conn, "dc1", "apps/order/app.yaml", "DEFAULT_GROUP");

    expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledWith(profile, {
      namespace: "dc1",
      dataId: "",
      group: "apps/order/",
      pageNo: 1,
      pageSize: 20,
    });
    expect(goApp.ConfigCenterGetConfig).toHaveBeenCalledWith(profile, ref);
  });

  it("blocks default direct writes before they can reach Wails bindings", async () => {
    localStorage.setItem("locale", "en-US");
    const conn = makeConnection("conn-direct-write");

    await expect(publishConfig(conn, "public", "app.yaml", "DEFAULT_GROUP", "a: 1", "yaml")).rejects.toThrow(
      "Direct config writes are disabled. Generate and execute an ApplyPlan instead."
    );
    await expect(deleteConfig(conn, "public", "app.yaml", "DEFAULT_GROUP")).rejects.toThrow(
      "Direct config writes are disabled. Generate and execute an ApplyPlan instead."
    );

    expect(goApp.NacosPublishConfig).not.toHaveBeenCalled();
    expect(goApp.NacosDeleteConfig).not.toHaveBeenCalled();
    expect(goApp.NacosPublishConfigFromApplyPlan).not.toHaveBeenCalled();
    expect(goApp.NacosDeleteConfigFromApplyPlan).not.toHaveBeenCalled();
    expect(goApp.ConfigCenterPublishConfig).not.toHaveBeenCalled();
    expect(goApp.ConfigCenterDeleteConfig).not.toHaveBeenCalled();
  });

  it("keeps apply-plan writes explicit and routed through dedicated Wails bindings", async () => {
    const conn = makeConnection("conn-apply-write");
    goApp.NacosPublishConfigFromApplyPlan.mockResolvedValue(undefined);
    goApp.NacosDeleteConfigFromApplyPlan.mockResolvedValue(undefined);

    await expect(publishConfigFromApplyPlan(conn, "public", "app.yaml", "DEFAULT_GROUP", "a: 1", "yaml")).resolves.toBeUndefined();
    await expect(deleteConfigFromApplyPlan(conn, "public", "app.yaml", "DEFAULT_GROUP")).resolves.toBeUndefined();

    expect(goApp.NacosPublishConfig).not.toHaveBeenCalled();
    expect(goApp.NacosDeleteConfig).not.toHaveBeenCalled();
    expect(goApp.NacosPublishConfigFromApplyPlan).toHaveBeenCalledWith(
      conn.baseUrl,
      "token-1",
      "v3",
      "public",
      "app.yaml",
      "DEFAULT_GROUP",
      "a: 1",
      "yaml"
    );
    expect(goApp.NacosDeleteConfigFromApplyPlan).toHaveBeenCalledWith(conn.baseUrl, "token-1", "v3", "public", "app.yaml", "DEFAULT_GROUP");
  });

  it("rejects apply-plan writes to local snapshot sources with localized readonly errors", async () => {
    localStorage.setItem("locale", "en-US");
    const conn: Connection = {
      ...makeConnection("conn-local-readonly"),
      sourceType: "local-snapshot",
      localPath: "C:\\backup\\prod",
      baseUrl: "C:\\backup\\prod",
      username: "",
      password: "",
    };

    await expect(publishConfigFromApplyPlan(conn, "", "app.yaml", "DEFAULT_GROUP", "a: 1", "yaml")).rejects.toThrow(
      "Local snapshot sources are read-only and cannot publish configs"
    );
    await expect(deleteConfigFromApplyPlan(conn, "", "app.yaml", "DEFAULT_GROUP")).rejects.toThrow(
      "Local snapshot sources are read-only and cannot delete configs"
    );
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
    expect(goApp.ConfigCenterListNamespaces).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "http://localhost:12875/nacos" }));
  });

  it("uses reusable SSH profiles when resolving tunnels", async () => {
    localStorage.setItem(
      "cs.sshProfiles",
      JSON.stringify([
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
      ])
    );
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
    expect(goApp.ConfigCenterTestConnection).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "http://localhost:13380/nacos" }));
  });
});

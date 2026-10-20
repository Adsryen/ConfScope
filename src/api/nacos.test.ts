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
  deleteConfigRefFromApplyPlan,
  listAllConfigs,
  listConfigs,
  listHistory,
  listNamespaces,
  publishConfig,
  publishConfigFromApplyPlan,
  publishConfigRefFromApplyPlan,
  testConnection,
} from "./nacos";
import { StaleRequestError } from "./nacos";
import type { Connection } from "../store/connections";

const goApp = {
  ConfigCenterListNamespaces: vi.fn(),
  ConfigCenterListConfigs: vi.fn(),
  ConfigCenterGetConfig: vi.fn(),
  ConfigCenterPublishConfig: vi.fn(),
  ConfigCenterDeleteConfig: vi.fn(),
  ConfigCenterPublishConfigFromApplyPlan: vi.fn(),
  ConfigCenterDeleteConfigFromApplyPlan: vi.fn(),
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
  GetSSHTunnelLocalPort: vi.fn(),
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
      app: {
        App: goApp,
      },
    });
    vi.stubGlobal("window", {
      go: {
        app: {
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
    // 映射层恒填 srcIp/srcUser/format（历史行的「谁在哪发的」与版本格式要有值可读）：
    // 服务端没给就是空串，而不是字段消失，UI 侧据此回退当前配置格式。
    await expect(listHistory(conn, "public", "app.yaml", "DEFAULT_GROUP", 1, 20)).resolves.toEqual({
      totalCount: 1,
      pageNumber: 1,
      pagesAvailable: 1,
      pageItems: [
        {
          id: "h-1",
          dataId: "app.yaml",
          group: "DEFAULT_GROUP",
          opType: "U",
          lastModifiedTime: "1710000000000",
          srcIp: "",
          srcUser: "",
          format: "",
        },
      ],
    });
    await expect(getHistoryDetail(conn, "public", "app.yaml", "DEFAULT_GROUP", "h-1")).resolves.toEqual({
      id: "h-1",
      dataId: "app.yaml",
      group: "DEFAULT_GROUP",
      content: "server:\n  port: 8080",
      opType: "U",
      createdTime: "1700000000000",
      lastModifiedTime: "1710000000000",
      // 与历史列表同一口径：这些字段恒填，缺省给空串（详情比列表多一个 md5 用于回退前校验）
      srcIp: "",
      srcUser: "",
      format: "",
      md5: "",
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
      "Direct config writes are disabled. Generate and execute a configuration change plan instead."
    );
    await expect(deleteConfig(conn, "public", "app.yaml", "DEFAULT_GROUP")).rejects.toThrow(
      "Direct config writes are disabled. Generate and execute a configuration change plan instead."
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

  it("routes provider apply-plan ref writes through generic ConfigCenter bindings without dropping keys", async () => {
    const conn: Connection = {
      ...makeConnection("conn-apollo-apply-ref"),
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
    const ref = {
      provider: "apollo" as const,
      connectionId: conn.id,
      namespace: "order-service",
      group: "DEFAULT_GROUP",
      dataId: "application",
      key: "feature.enabled",
      expectedVersion: "42",
    };
    goApp.ConfigCenterPublishConfigFromApplyPlan.mockResolvedValue(undefined);
    goApp.ConfigCenterDeleteConfigFromApplyPlan.mockResolvedValue(undefined);

    await publishConfigRefFromApplyPlan(conn, ref, "enabled", "properties");
    await deleteConfigRefFromApplyPlan(conn, ref);

    const expected = {
      ...ref,
      group: "default",
    };
    expect(goApp.ConfigCenterPublishConfigFromApplyPlan).toHaveBeenCalledWith(expect.objectContaining({ provider: "apollo" }), {
      ref: expected,
      content: "enabled",
      format: "properties",
    });
    expect(goApp.ConfigCenterDeleteConfigFromApplyPlan).toHaveBeenCalledWith(expect.objectContaining({ provider: "apollo" }), expected);
    expect(goApp.NacosPublishConfigFromApplyPlan).not.toHaveBeenCalled();
    expect(goApp.NacosDeleteConfigFromApplyPlan).not.toHaveBeenCalled();
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
    expect(goApp.ConfigCenterListNamespaces).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "http://127.0.0.1:12875/nacos" }));
  });

  it("rebuilds cached SSH tunnels and retries namespace reads after local tunnel transport errors", async () => {
    const conn: Connection = {
      ...makeConnection("conn-ssh-reconnect"),
      baseUrl: "http://nacos.internal:8848/nacos",
      sshConfig: {
        host: "jump.example.com",
        port: 22,
        username: "root",
        authType: "password",
        password: "ssh-secret",
      },
    };
    goApp.CreateSSHTunnel.mockResolvedValueOnce(5972).mockResolvedValueOnce(6001);
    goApp.ConfigCenterListNamespaces
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(
        new Error(
          '无法连接到服务器: Get "http://localhost:5972/nacos/v3/console/core/namespace/list": dial tcp [::1]:5972: connectex: No connection could be made because the target machine actively refused it.'
        )
      )
      .mockResolvedValueOnce([{ id: "public", name: "Public", configCount: 1, kind: 2 }]);

    await expect(listNamespaces(conn)).resolves.toEqual([]);
    await expect(listNamespaces(conn)).resolves.toEqual([{ namespace: "public", namespaceShowName: "Public", configCount: 1, kind: 2 }]);

    expect(goApp.CreateSSHTunnel).toHaveBeenCalledTimes(2);
    expect(goApp.StopSSHTunnel).toHaveBeenCalledWith(conn.id);
    expect(goApp.ConfigCenterListNamespaces).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl: "http://127.0.0.1:6001/nacos" }));
  });


  it("adopts backend current SSH tunnel port when frontend cache is stale", async () => {
    const conn: Connection = {
      ...makeConnection("conn-ssh-stale-cache"),
      baseUrl: "http://nacos.internal:8848/nacos",
      sshConfig: {
        host: "jump.example.com",
        port: 22,
        username: "root",
        authType: "password",
        password: "ssh-secret",
      },
    };
    goApp.CreateSSHTunnel.mockResolvedValueOnce(9673);
    goApp.GetSSHTunnelLocalPort.mockResolvedValueOnce(9673).mockResolvedValue(9677);
    goApp.ConfigCenterListNamespaces.mockResolvedValue([]);

    await expect(listNamespaces(conn)).resolves.toEqual([]);
    await expect(listNamespaces(conn)).resolves.toEqual([]);

    expect(goApp.CreateSSHTunnel).toHaveBeenCalledTimes(1);
    expect(goApp.ConfigCenterListNamespaces).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl: "http://127.0.0.1:9677/nacos" }));
  });

  it("deduplicates concurrent SSH tunnel creation for the same connection", async () => {
    const conn: Connection = {
      ...makeConnection("conn-ssh-concurrent-create"),
      baseUrl: "http://nacos.internal:8848/nacos",
      sshConfig: {
        host: "jump.example.com",
        port: 22,
        username: "root",
        authType: "password",
        password: "ssh-secret",
      },
    };
    goApp.CreateSSHTunnel.mockResolvedValueOnce(9682);
    goApp.ConfigCenterListNamespaces.mockResolvedValue([]);

    await expect(Promise.all([listNamespaces(conn), listNamespaces(conn)])).resolves.toEqual([[], []]);

    expect(goApp.CreateSSHTunnel).toHaveBeenCalledTimes(1);
    expect(goApp.ConfigCenterListNamespaces).toHaveBeenCalledTimes(2);
    expect(goApp.ConfigCenterListNamespaces).toHaveBeenNthCalledWith(1, expect.objectContaining({ baseUrl: "http://127.0.0.1:9682/nacos" }));
    expect(goApp.ConfigCenterListNamespaces).toHaveBeenNthCalledWith(2, expect.objectContaining({ baseUrl: "http://127.0.0.1:9682/nacos" }));
  });

  it("rebuilds SSH tunnels and retries when login response is cut off", async () => {
    const conn: Connection = {
      ...makeConnection("conn-ssh-eof-reconnect"),
      baseUrl: "http://nacos.internal:8848/nacos",
      username: "nacos",
      password: "secret",
      sshConfig: {
        host: "jump.example.com",
        port: 22,
        username: "root",
        authType: "password",
        password: "ssh-secret",
      },
    };
    goApp.CreateSSHTunnel.mockResolvedValueOnce(4663).mockResolvedValueOnce(4664);
    goApp.NacosDetectVersion.mockResolvedValue("v1");
    goApp.NacosLogin.mockRejectedValueOnce(new Error("读取登录响应失败: unexpected EOF")).mockResolvedValueOnce({
      accessToken: "fresh-token",
      tokenTtl: 18000,
      globalAdmin: false,
    });
    goApp.ConfigCenterListNamespaces.mockResolvedValueOnce([{ id: "public", name: "Public", configCount: 1, kind: 2 }]);

    await expect(listNamespaces(conn)).resolves.toEqual([{ namespace: "public", namespaceShowName: "Public", configCount: 1, kind: 2 }]);

    expect(goApp.CreateSSHTunnel).toHaveBeenCalledTimes(2);
    expect(goApp.StopSSHTunnel).toHaveBeenCalledWith(conn.id);
    expect(goApp.NacosLogin).toHaveBeenLastCalledWith("http://127.0.0.1:4664/nacos", "nacos", "secret", "v1");
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
    expect(goApp.ConfigCenterTestConnection).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "http://127.0.0.1:13380/nacos" }));
  });

  describe("listAllConfigs 聚合翻页", () => {
    /** 造一条 configCenter 列表项（ref 形状与 Go DTO 对齐）。 */
    const item = (conn: Connection, dataId: string, group = "DEFAULT_GROUP") => ({
      ref: expectedRef(conn, "public", dataId, group),
      content: `content-of-${dataId}`,
      format: "text",
      updateTime: "2026-10-17T00:00:00Z",
    });

    /** 让列表接口按 pageNo 返回不同页内容，并可指定某些页失败。 */
    function mockPages(opts: {
      pagesAvailable: number;
      perPage?: number;
      failPages?: number[];
      totalCountOverride?: number;
      extraGroupItem?: boolean;
    }) {
      const conn = currentConn;
      const perPage = opts.perPage ?? 2;
      goApp.ConfigCenterListConfigs.mockImplementation(async (_profile: unknown, query: { pageNo: number; pageSize: number }) => {
        if (opts.failPages?.includes(query.pageNo)) throw new Error(`page ${query.pageNo} exploded`);
        const items = Array.from({ length: perPage }, (_, i) => item(conn, `app-${query.pageNo}-${i}`));
        if (opts.extraGroupItem) items.push(item(conn, `stray-${query.pageNo}`, "OTHER_GROUP"));
        return {
          totalCount: opts.totalCountOverride ?? perPage,
          pageNumber: query.pageNo,
          pagesAvailable: opts.pagesAvailable,
          pageItems: items,
        };
      });
    }

    let currentConn: Connection = makeConnection("conn-all-placeholder");

    beforeEach(() => {
      currentConn = makeConnection(`conn-all-${Date.now()}-${Math.random()}`);
    });

    it("按 pagesAvailable 逐页取全并回报进度", async () => {
      mockPages({ pagesAvailable: 3 });
      const progress: number[] = [];

      const result = await listAllConfigs(currentConn, "public", "", "DEFAULT_GROUP", {
        pageSize: 2,
        onProgress: (loaded) => progress.push(loaded),
      });

      expect(result.items.map((entry) => entry.dataId)).toEqual(["app-1-0", "app-1-1", "app-2-0", "app-2-1", "app-3-0", "app-3-1"]);
      expect(result).toMatchObject({ pagesAvailable: 3, loadedPages: 3, failedPages: [], truncated: false });
      expect(progress).toEqual([2, 4, 6]);
      expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledTimes(3);
      expect(goApp.ConfigCenterListConfigs).toHaveBeenLastCalledWith(expectedProfile(currentConn), {
        namespace: "public",
        dataId: "",
        group: "DEFAULT_GROUP",
        pageNo: 3,
        pageSize: 2,
      });
    });

    it("判页数只信 pagesAvailable，不信被 group 过滤改写过的 totalCount", async () => {
      // group 精确兜底过滤会把 totalCount 改写成过滤后长度，聚合仍必须继续翻到 pagesAvailable
      mockPages({ pagesAvailable: 4, perPage: 1, totalCountOverride: 1, extraGroupItem: true });

      const result = await listAllConfigs(currentConn, "public", "", "DEFAULT_GROUP", { pageSize: 1 });

      expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledTimes(4);
      expect(result.items.map((entry) => entry.dataId)).toEqual(["app-1-0", "app-2-0", "app-3-0", "app-4-0"]);
      expect(result.pagesAvailable).toBe(4);
      expect(result.truncated).toBe(false);
    });

    it("超过安全上限时只拉到上限并置 truncated", async () => {
      mockPages({ pagesAvailable: 10, perPage: 1 });

      const result = await listAllConfigs(currentConn, "public", "", "DEFAULT_GROUP", { pageSize: 1, safeCap: 3 });

      expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledTimes(3);
      expect(result.items).toHaveLength(3);
      expect(result.truncated).toBe(true);
      expect(result.pagesAvailable).toBe(10);
    });

    it("未超过安全上限时 truncated 为 false", async () => {
      mockPages({ pagesAvailable: 3, perPage: 1 });

      const result = await listAllConfigs(currentConn, "public", "", "DEFAULT_GROUP", { pageSize: 1, safeCap: 3 });

      expect(result.truncated).toBe(false);
      expect(result.loadedPages).toBe(3);
    });

    it("首页失败直接抛出，由调用方走既有错误展示", async () => {
      mockPages({ pagesAvailable: 3, failPages: [1] });

      await expect(listAllConfigs(currentConn, "public", "", "DEFAULT_GROUP", { pageSize: 2 })).rejects.toThrow("page 1 exploded");
      expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledTimes(1);
    });

    it("后续页失败不抛错而是回报失败页并停止翻页", async () => {
      mockPages({ pagesAvailable: 4, perPage: 1, failPages: [3] });

      const result = await listAllConfigs(currentConn, "public", "", "DEFAULT_GROUP", { pageSize: 1 });

      expect(result.items.map((entry) => entry.dataId)).toEqual(["app-1-0", "app-2-0"]);
      expect(result.failedPages).toEqual([3]);
      expect(result.loadedPages).toBe(2);
      expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledTimes(3);
    });

    it("请求作废时抛 StaleRequestError 并立即停止翻页", async () => {
      mockPages({ pagesAvailable: 3, perPage: 1 });
      let stale = false;

      const pending = listAllConfigs(currentConn, "public", "", "DEFAULT_GROUP", {
        pageSize: 1,
        isStale: () => stale,
      });
      stale = true;

      await expect(pending).rejects.toBeInstanceOf(StaleRequestError);
      expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledTimes(1);
    });

    it("每页都保留 group 精确兜底过滤语义", async () => {
      mockPages({ pagesAvailable: 2, perPage: 1, extraGroupItem: true });

      const result = await listAllConfigs(currentConn, "public", "", "DEFAULT_GROUP", { pageSize: 1 });

      expect(result.items.every((entry) => entry.group === "DEFAULT_GROUP")).toBe(true);
      expect(result.items.map((entry) => entry.dataId)).toEqual(["app-1-0", "app-2-0"]);
    });
  });
});

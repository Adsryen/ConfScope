/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteConfig,
  deleteConfigFromApplyPlan,
  getConfig,
  getHistoryDetail,
  listConfigs,
  listHistory,
  listNamespaces,
  publishConfig,
  publishConfigFromApplyPlan,
  testConnection,
  type ConfigRef,
  type ConnectionProfile,
} from "./configCenter";

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
};

describe("config center api", () => {
  const profile: ConnectionProfile = {
    id: "conn-1",
    name: "dev",
    provider: "nacos",
    distribution: "opensource",
    authType: "nacos-password",
    baseUrl: "http://127.0.0.1:8848/nacos",
    accessToken: "token",
    apiVersion: "v3",
    accessKeyId: "",
    accessKeySecret: "",
    securityToken: "",
    environment: "dev",
    safetyLevel: "test",
    useProxy: false,
    apolloEnv: "",
    apolloAppId: "",
    apolloCluster: "",
    apolloNamespaceName: "",
    consulDatacenter: "",
    consulKeyPrefix: "",
  };
  const ref: ConfigRef = {
    provider: "nacos",
    connectionId: "conn-1",
    namespace: "public",
    group: "DEFAULT_GROUP",
    dataId: "app.yaml",
    key: "",
  };

  beforeEach(() => {
    for (const fn of Object.values(goApp)) fn.mockReset();
    localStorage.clear();
    vi.stubGlobal("go", {
      main: {
        App: goApp,
      },
    });
  });

  it("passes profile to namespace and connection calls", async () => {
    goApp.ConfigCenterListNamespaces.mockResolvedValue([{ id: "public", name: "Public" }]);
    goApp.ConfigCenterTestConnection.mockResolvedValue(undefined);

    await expect(listNamespaces(profile)).resolves.toEqual([{ id: "public", name: "Public" }]);
    await expect(testConnection(profile)).resolves.toBeUndefined();

    expect(goApp.ConfigCenterListNamespaces).toHaveBeenCalledWith(profile);
    expect(goApp.ConfigCenterTestConnection).toHaveBeenCalledWith(profile);
  });

  it("passes typed config requests to Wails bindings", async () => {
    goApp.ConfigCenterListConfigs.mockResolvedValue({ totalCount: 1, pageItems: [] });
    goApp.ConfigCenterGetConfig.mockResolvedValue({ ref, content: "a: 1" });

    await listConfigs(profile, { namespace: "public", group: "DEFAULT_GROUP", dataId: "app", pageNo: 1, pageSize: 20 });
    await getConfig(profile, ref);

    expect(goApp.ConfigCenterListConfigs).toHaveBeenCalledWith(profile, {
      namespace: "public",
      group: "DEFAULT_GROUP",
      dataId: "app",
      pageNo: 1,
      pageSize: 20,
    });
    expect(goApp.ConfigCenterGetConfig).toHaveBeenCalledWith(profile, ref);
  });

  it("blocks default direct writes before they can reach Wails bindings", async () => {
    localStorage.setItem("locale", "en-US");

    await expect(publishConfig(profile, { ref, content: "a: 1", format: "yaml" })).rejects.toThrow(
      "Direct config writes are disabled. Generate and execute an ApplyPlan instead."
    );
    await expect(deleteConfig(profile, ref)).rejects.toThrow(
      "Direct config writes are disabled. Generate and execute an ApplyPlan instead."
    );

    expect(goApp.ConfigCenterPublishConfig).not.toHaveBeenCalled();
    expect(goApp.ConfigCenterDeleteConfig).not.toHaveBeenCalled();
    expect(goApp.ConfigCenterPublishConfigFromApplyPlan).not.toHaveBeenCalled();
    expect(goApp.ConfigCenterDeleteConfigFromApplyPlan).not.toHaveBeenCalled();
  });

  it("passes apply-plan config writes to dedicated Wails bindings", async () => {
    goApp.ConfigCenterPublishConfigFromApplyPlan.mockResolvedValue(undefined);
    goApp.ConfigCenterDeleteConfigFromApplyPlan.mockResolvedValue(undefined);

    await publishConfigFromApplyPlan(profile, { ref, content: "a: 1", format: "yaml" });
    await deleteConfigFromApplyPlan(profile, ref);

    expect(goApp.ConfigCenterPublishConfig).not.toHaveBeenCalled();
    expect(goApp.ConfigCenterDeleteConfig).not.toHaveBeenCalled();
    expect(goApp.ConfigCenterPublishConfigFromApplyPlan).toHaveBeenCalledWith(profile, { ref, content: "a: 1", format: "yaml" });
    expect(goApp.ConfigCenterDeleteConfigFromApplyPlan).toHaveBeenCalledWith(profile, ref);
  });

  it("passes typed history requests to Wails bindings", async () => {
    goApp.ConfigCenterListHistory.mockResolvedValue({ totalCount: 1, pageItems: [] });
    goApp.ConfigCenterGetHistoryDetail.mockResolvedValue({ id: "42", ref, content: "a: 1" });

    await listHistory(profile, ref, { pageNo: 1, pageSize: 20 });
    await getHistoryDetail(profile, ref, "42");

    expect(goApp.ConfigCenterListHistory).toHaveBeenCalledWith(profile, ref, { pageNo: 1, pageSize: 20 });
    expect(goApp.ConfigCenterGetHistoryDetail).toHaveBeenCalledWith(profile, ref, "42");
  });
});

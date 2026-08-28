import type { Page } from "@playwright/test";
import { createRetestInvoke } from "./retestBinding";
import { createRetestStorageSeed } from "./storageSeed";
import type { RetestState } from "../state";

const WAILS_METHODS = [
  "GetAppInfo",
  "CheckForUpdates",
  "GetCurrentPlatform",
  "SelectLocalSnapshotDirectory",
  "ValidateLocalSnapshotDirectory",
  "ConfigCenterListNamespaces",
  "ConfigCenterListConfigs",
  "ConfigCenterGetConfig",
  "ConfigCenterPublishConfig",
  "ConfigCenterDeleteConfig",
  "ConfigCenterPublishConfigFromApplyPlan",
  "ConfigCenterPublishConfigRefFromApplyPlan",
  "ConfigCenterDeleteConfigFromApplyPlan",
  "ConfigCenterDeleteConfigRefFromApplyPlan",
  "ConfigCenterListHistory",
  "ConfigCenterGetHistoryDetail",
  "ConfigCenterTestConnection",
  "NacosDetectVersion",
  "NacosLogin",
  "NacosNamespaces",
  "NacosListConfigs",
  "NacosGetConfig",
  "NacosHistoryList",
  "NacosHistoryDetail",
  "NacosPublishConfig",
  "NacosPublishConfigFromApplyPlan",
  "NacosDeleteConfig",
  "NacosDeleteConfigFromApplyPlan",
  "CreateSSHTunnel",
  "TestSSHConnection",
  "StopSSHTunnel",
  "StopAllSSHTunnels",
  "GetSSHTunnelLocalPort",
  "GetDownloadProgress",
  "DownloadUpdate",
  "InstallAndRestart",
  "CreateSnapshot",
  "GetSnapshot",
  "ListSnapshots",
  "DeleteSnapshot",
  "ValidateSnapshot",
  "SelectAppDataBackupSaveFile",
  "SelectAppDataBackupOpenFile",
  "WriteAppDataBackupFile",
  "ReadAppDataBackupFile",
  "CreateAppDataRecoveryPoint",
  "TestAppDataWebDAV",
  "ListAppDataWebDAVBackups",
  "UploadAppDataWebDAVBackup",
  "DownloadAppDataWebDAVBackup",
  "TestSnapshotWebDAV",
  "ListSnapshotWebDAVPackages",
  "UploadSnapshotWebDAVPackage",
  "ImportSnapshotWebDAVPackage",
] as const;

export async function installRetestBridge(page: Page, state: RetestState): Promise<void> {
  const invoke = createRetestInvoke();
  await page.exposeFunction("__confscopeRetestInvoke", (method: string, args: unknown[]) => invoke(method, args));
  await page.addInitScript(
    ({ methods, storage }) => {
      const target = window as unknown as {
        __confscopeRetestInvoke: (method: string, args: unknown[]) => Promise<unknown>;
        go: { main: { App: Record<string, (...args: unknown[]) => Promise<unknown>> } };
        runtime: {
          EventsOn: (eventName: string, callback: (payload: unknown) => void) => void;
          EventsOff: (eventName: string, callback: (payload: unknown) => void) => void;
        };
      };
      if (window.localStorage.getItem("retest.bridge.marker") !== "1") {
        // 每次新浏览器上下文（spec 文件级 page）强制刷新播种数据：
        // 复测容器是持久化的，跨 run 残留的 cs.* 状态会污染历史/审计/任务断言
        window.localStorage.clear();
      }
      for (const item of storage) {
        window.localStorage.setItem(item.key, item.value);
      }
      window.localStorage.setItem("retest.bridge.marker", "1");
      const app: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      for (const item of methods) {
        app[item] = (...args: unknown[]) => target.__confscopeRetestInvoke(item, args);
      }
      target.go = { main: { App: app } };
      target.runtime = {
        EventsOn: () => undefined,
        EventsOff: () => undefined,
      };
    },
    { methods: [...WAILS_METHODS], storage: createRetestStorageSeed(state) }
  );
}

export const RETEST_BRIDGE_MARKER = "retest.bridge.marker";

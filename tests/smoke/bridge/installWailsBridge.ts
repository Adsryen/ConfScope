import type { Page } from "@playwright/test";
import { createSmokeAppBinding } from "./appBinding";
import { createStorageSeed } from "./storageSeed";
import type { SmokeState } from "../env/workspace";

const WAILS_METHODS = [
  "GetAppInfo",
  "CheckForUpdates",
  "DownloadUpdate",
  "GetDownloadProgress",
  "InstallAndRestart",
  "GetCurrentPlatform",
  "SelectLocalSnapshotDirectory",
  "ValidateLocalSnapshotDirectory",
  "ConfigCenterListNamespaces",
  "ConfigCenterListConfigs",
  "ConfigCenterGetConfig",
  "ConfigCenterPublishConfig",
  "ConfigCenterDeleteConfig",
  "ConfigCenterPublishConfigFromApplyPlan",
  "ConfigCenterDeleteConfigFromApplyPlan",
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

export async function installWailsBridge(page: Page, state: SmokeState): Promise<void> {
  const invoke = createSmokeAppBinding(state);
  await page.exposeFunction("__confscopeSmokeInvoke", (method: string, args: unknown[]) => invoke(method, args));
  await page.addInitScript(
    ({ methods, storage }) => {
      const target = window as unknown as {
        __confscopeSmokeInvoke: (method: string, args: unknown[]) => Promise<unknown>;
        go: { app: { App: Record<string, (...args: unknown[]) => Promise<unknown>> } };
        runtime: {
          EventsOn: (eventName: string, callback: (payload: unknown) => void) => void;
          EventsOff: (eventName: string) => void;
        };
      };
      for (const item of storage) {
        if (window.localStorage.getItem(item.key) === null) {
          window.localStorage.setItem(item.key, item.value);
        }
      }
      const app: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
      for (const method of methods) {
        app[method] = (...args: unknown[]) => target.__confscopeSmokeInvoke(method, args);
      }
      target.go = { app: { App: app } };
      target.runtime = {
        EventsOn: () => undefined,
        EventsOff: () => undefined,
      };
    },
    { methods: [...WAILS_METHODS], storage: createStorageSeed(state) }
  );
}

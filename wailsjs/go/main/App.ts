type GoApp = {
  GetAppInfo(): Promise<any>;
  CheckForUpdates(request: any): Promise<any>;
  DownloadUpdate(downloadURL: string, sha256: string): Promise<string>;
  GetDownloadProgress(): Promise<any>;
  InstallAndRestart(downloadedFile: string): Promise<void>;
  GetCurrentPlatform(): Promise<string>;
  SelectLocalSnapshotDirectory(): Promise<string>;
  ValidateLocalSnapshotDirectory(path: string): Promise<any>;
  ConfigCenterListNamespaces(profile: any): Promise<any>;
  ConfigCenterListConfigs(profile: any, request: any): Promise<any>;
  ConfigCenterGetConfig(profile: any, ref: any): Promise<any>;
  ConfigCenterPublishConfig(profile: any, request: any): Promise<void>;
  ConfigCenterDeleteConfig(profile: any, ref: any): Promise<void>;
  ConfigCenterListHistory(profile: any, ref: any, page: any): Promise<any>;
  ConfigCenterGetHistoryDetail(profile: any, ref: any, id: string): Promise<any>;
  ConfigCenterTestConnection(profile: any): Promise<void>;
  NacosDetectVersion(baseUrl: string): Promise<string>;
  NacosLogin(baseUrl: string, username: string, password: string, apiVersion: string): Promise<any>;
  NacosNamespaces(baseUrl: string, accessToken: string, apiVersion: string): Promise<any>;
  NacosListConfigs(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string,
    pageNo: number,
    pageSize: number
  ): Promise<any>;
  NacosGetConfig(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string
  ): Promise<string>;
  NacosHistoryList(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string,
    pageNo: number,
    pageSize: number
  ): Promise<any>;
  NacosHistoryDetail(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string,
    nid: string
  ): Promise<any>;
  NacosPublishConfig(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string,
    content: string,
    configType: string
  ): Promise<void>;
  NacosDeleteConfig(
    baseUrl: string,
    accessToken: string,
    apiVersion: string,
    namespace: string,
    dataId: string,
    group: string
  ): Promise<void>;
  CreateSSHTunnel(connectionId: string, config: any): Promise<number>;
  TestSSHConnection(config: any): Promise<any>;
  StopSSHTunnel(connectionId: string): Promise<void>;
  StopAllSSHTunnels(): Promise<void>;
  GetSSHTunnelLocalPort(connectionId: string): Promise<number>;
};

declare global {
  interface Window {
    go: {
      main: {
        App: GoApp;
      };
    };
  }
}

const app = () => window.go.main.App;

export const GetAppInfo = () => app().GetAppInfo();

export const CheckForUpdates = (request: any) => app().CheckForUpdates(request);

export const DownloadUpdate = (downloadURL: string, sha256: string) =>
  app().DownloadUpdate(downloadURL, sha256);

export const GetDownloadProgress = () => app().GetDownloadProgress();

export const InstallAndRestart = (downloadedFile: string) =>
  app().InstallAndRestart(downloadedFile);

export const GetCurrentPlatform = () => app().GetCurrentPlatform();

export const SelectLocalSnapshotDirectory = () => app().SelectLocalSnapshotDirectory();

export const ValidateLocalSnapshotDirectory = (path: string) =>
  app().ValidateLocalSnapshotDirectory(path);

export const ConfigCenterListNamespaces = (profile: any) =>
  app().ConfigCenterListNamespaces(profile);

export const ConfigCenterListConfigs = (profile: any, request: any) =>
  app().ConfigCenterListConfigs(profile, request);

export const ConfigCenterGetConfig = (profile: any, ref: any) =>
  app().ConfigCenterGetConfig(profile, ref);

export const ConfigCenterPublishConfig = (profile: any, request: any) =>
  app().ConfigCenterPublishConfig(profile, request);

export const ConfigCenterDeleteConfig = (profile: any, ref: any) =>
  app().ConfigCenterDeleteConfig(profile, ref);

export const ConfigCenterListHistory = (profile: any, ref: any, page: any) =>
  app().ConfigCenterListHistory(profile, ref, page);

export const ConfigCenterGetHistoryDetail = (profile: any, ref: any, id: string) =>
  app().ConfigCenterGetHistoryDetail(profile, ref, id);

export const ConfigCenterTestConnection = (profile: any) =>
  app().ConfigCenterTestConnection(profile);

export const NacosDetectVersion = (baseUrl: string) => app().NacosDetectVersion(baseUrl);

export const NacosLogin = (baseUrl: string, username: string, password: string, apiVersion: string) =>
  app().NacosLogin(baseUrl, username, password, apiVersion);

export const NacosNamespaces = (baseUrl: string, accessToken: string, apiVersion: string) =>
  app().NacosNamespaces(baseUrl, accessToken, apiVersion);

export const NacosListConfigs = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string,
  pageNo: number,
  pageSize: number
) => app().NacosListConfigs(baseUrl, accessToken, apiVersion, namespace, dataId, group, pageNo, pageSize);

export const NacosGetConfig = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string
) => app().NacosGetConfig(baseUrl, accessToken, apiVersion, namespace, dataId, group);

export const NacosHistoryList = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string,
  pageNo: number,
  pageSize: number
) => app().NacosHistoryList(baseUrl, accessToken, apiVersion, namespace, dataId, group, pageNo, pageSize);

export const NacosHistoryDetail = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string,
  nid: string
) => app().NacosHistoryDetail(baseUrl, accessToken, apiVersion, namespace, dataId, group, nid);

export const NacosPublishConfig = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string,
  content: string,
  configType: string
) => app().NacosPublishConfig(baseUrl, accessToken, apiVersion, namespace, dataId, group, content, configType);

export const NacosDeleteConfig = (
  baseUrl: string,
  accessToken: string,
  apiVersion: string,
  namespace: string,
  dataId: string,
  group: string
) => app().NacosDeleteConfig(baseUrl, accessToken, apiVersion, namespace, dataId, group);

export const CreateSSHTunnel = (connectionId: string, config: any) =>
  app().CreateSSHTunnel(connectionId, config);

export const TestSSHConnection = (config: any) =>
  app().TestSSHConnection(config);

export const StopSSHTunnel = (connectionId: string) =>
  app().StopSSHTunnel(connectionId);

export const StopAllSSHTunnels = () =>
  app().StopAllSSHTunnels();

export const GetSSHTunnelLocalPort = (connectionId: string) =>
  app().GetSSHTunnelLocalPort(connectionId);

export {};

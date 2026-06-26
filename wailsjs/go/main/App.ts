type GoApp = {
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

export const StopSSHTunnel = (connectionId: string) =>
  app().StopSSHTunnel(connectionId);

export const StopAllSSHTunnels = () =>
  app().StopAllSSHTunnels();

export const GetSSHTunnelLocalPort = (connectionId: string) =>
  app().GetSSHTunnelLocalPort(connectionId);

export {};

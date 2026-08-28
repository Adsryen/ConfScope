import {
  ConfigCenterDeleteConfigFromApplyPlan,
  ConfigCenterGetConfig,
  ConfigCenterGetHistoryDetail,
  ConfigCenterListConfigs,
  ConfigCenterListHistory,
  ConfigCenterListNamespaces,
  ConfigCenterPublishConfigFromApplyPlan,
  ConfigCenterTestConnection,
} from "../../wailsjs/go/main/App";
import { translate } from "../locales";

export type ProviderType = "nacos" | "apollo" | "consul" | "local";
export type Distribution = "opensource" | "aliyun-mse";
export type AuthType = "none" | "nacos-password" | "aliyun-aksk";

export interface ConnectionProfile {
  id: string;
  name: string;
  provider: ProviderType;
  distribution: Distribution;
  authType: AuthType;
  baseUrl: string;
  accessToken: string;
  apiVersion: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  environment: string;
  safetyLevel: string;
  useProxy: boolean;
  apolloEnv: string;
  apolloAppId: string;
  apolloCluster: string;
  apolloNamespaceName: string;
  consulDatacenter: string;
  consulKeyPrefix: string;
}

export interface ConfigRef {
  provider: ProviderType;
  connectionId: string;
  namespace: string;
  group: string;
  dataId: string;
  key: string;
  expectedVersion?: string;
}

export interface Namespace {
  id: string;
  name: string;
  configCount: number;
  kind: number;
}

export interface PageRequest {
  pageNo: number;
  pageSize: number;
}

export interface ListConfigsRequest extends PageRequest {
  namespace: string;
  group: string;
  dataId: string;
}

export interface ConfigSummary {
  ref: ConfigRef;
  content: string;
  format: string;
  updateTime: string;
}

export interface ConfigPage {
  totalCount: number;
  pageNumber: number;
  pagesAvailable: number;
  pageItems: ConfigSummary[];
}

export interface ConfigDocument {
  ref: ConfigRef;
  content: string;
  format: string;
  version: string;
  source: string;
  updateTime: string;
}

export interface PublishConfigRequest {
  ref: ConfigRef;
  content: string;
  format: string;
}

export interface HistoryItem {
  id: string;
  ref: ConfigRef;
  opType: string;
  lastModifiedTime: string;
  /** nacos 原生平铺形态兜底字段（Wails runtime 序列化 Go 零值字段时 ref.dataId 可能缺失） */
  dataId?: string;
  group?: string;
}

export interface HistoryPage {
  totalCount: number;
  pageNumber: number;
  pagesAvailable: number;
  pageItems: HistoryItem[];
}

export interface HistoryDetail {
  id: string;
  ref: ConfigRef;
  content: string;
  opType: string;
  createdTime: string;
  lastModifiedTime: string;
}

export function listNamespaces(profile: ConnectionProfile): Promise<Namespace[]> {
  return ConfigCenterListNamespaces(profile);
}

export function listConfigs(profile: ConnectionProfile, request: ListConfigsRequest): Promise<ConfigPage> {
  return ConfigCenterListConfigs(profile, request);
}

export function getConfig(profile: ConnectionProfile, ref: ConfigRef): Promise<ConfigDocument> {
  return ConfigCenterGetConfig(profile, ref);
}

export async function publishConfig(_profile: ConnectionProfile, _request: PublishConfigRequest): Promise<void> {
  throw new Error(translate("api.directWriteRequiresApplyPlan"));
}

export async function deleteConfig(_profile: ConnectionProfile, _ref: ConfigRef): Promise<void> {
  throw new Error(translate("api.directWriteRequiresApplyPlan"));
}

export function publishConfigFromApplyPlan(profile: ConnectionProfile, request: PublishConfigRequest): Promise<void> {
  return ConfigCenterPublishConfigFromApplyPlan(profile, request);
}

export function deleteConfigFromApplyPlan(profile: ConnectionProfile, ref: ConfigRef): Promise<void> {
  return ConfigCenterDeleteConfigFromApplyPlan(profile, ref);
}

export function listHistory(profile: ConnectionProfile, ref: ConfigRef, page: PageRequest): Promise<HistoryPage> {
  return ConfigCenterListHistory(profile, ref, page);
}

export function getHistoryDetail(profile: ConnectionProfile, ref: ConfigRef, id: string): Promise<HistoryDetail> {
  return ConfigCenterGetHistoryDetail(profile, ref, id);
}

export function testConnection(profile: ConnectionProfile): Promise<void> {
  return ConfigCenterTestConnection(profile);
}

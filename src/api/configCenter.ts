import {
  ConfigCenterDeleteConfig,
  ConfigCenterGetConfig,
  ConfigCenterGetHistoryDetail,
  ConfigCenterListConfigs,
  ConfigCenterListHistory,
  ConfigCenterListNamespaces,
  ConfigCenterPublishConfig,
  ConfigCenterTestConnection,
} from "../../wailsjs/go/main/App";

export type ProviderType = "nacos" | "apollo" | "consul" | "local";

export interface ConnectionProfile {
  id: string;
  name: string;
  provider: ProviderType;
  baseUrl: string;
  accessToken: string;
  apiVersion: string;
  environment: string;
  safetyLevel: string;
}

export interface ConfigRef {
  provider: ProviderType;
  connectionId: string;
  namespace: string;
  group: string;
  dataId: string;
  key: string;
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

export function publishConfig(profile: ConnectionProfile, request: PublishConfigRequest): Promise<void> {
  return ConfigCenterPublishConfig(profile, request);
}

export function deleteConfig(profile: ConnectionProfile, ref: ConfigRef): Promise<void> {
  return ConfigCenterDeleteConfig(profile, ref);
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

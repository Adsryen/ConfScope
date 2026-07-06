import type { SmokeNacosEndpoint } from "./workspace";

export interface SmokeNacosConfig {
  namespace: string;
  group: string;
  dataId: string;
  content: string;
  type: string;
}

export interface SmokeNacosConfigSummary {
  dataId: string;
  group: string;
  content: string;
  configType: string;
  updateTime: string;
}

export async function waitForNacos(endpoint: SmokeNacosEndpoint, timeoutMs = 180_000): Promise<void> {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      await listNacosConfigs(endpoint, { namespace: "", group: "DEFAULT_GROUP", dataId: "", pageNo: 1, pageSize: 1 });
      return;
    } catch (error) {
      lastError = String(error);
      await sleep(2_000);
    }
  }
  throw new Error(`Nacos ${endpoint.role} not ready: ${lastError}`);
}

export async function seedNacos(endpoint: SmokeNacosEndpoint): Promise<void> {
  const configs = configsForRole(endpoint.role);
  for (const config of configs) {
    await publishNacosConfig(endpoint, config);
  }
  for (const config of configs) {
    const content = await waitForNacosContent(endpoint, config);
    if (content.trim() !== config.content.trim()) {
      throw new Error(`Seed verification failed for ${endpoint.role}/${config.dataId}`);
    }
  }
}

export async function cleanupNacosSeed(endpoint: SmokeNacosEndpoint): Promise<void> {
  for (const config of configsForRole(endpoint.role)) {
    try {
      await deleteNacosConfig(endpoint, config);
    } catch {
      // 清理失败不覆盖真实测试结果。
    }
  }
}

export async function publishNacosConfig(endpoint: SmokeNacosEndpoint, config: SmokeNacosConfig): Promise<void> {
  const body = new URLSearchParams();
  body.set("dataId", config.dataId);
  body.set("group", config.group);
  body.set("content", config.content);
  body.set("type", config.type);
  if (config.namespace) body.set("tenant", config.namespace);
  const response = await fetch(nacosUrl(endpoint, "/v1/cs/configs"), { method: "POST", body });
  const text = await response.text();
  if (!response.ok || text.trim() !== "true") {
    throw new Error(`Nacos publish failed ${response.status}: ${text}`);
  }
}

export async function deleteNacosConfig(endpoint: SmokeNacosEndpoint, config: Pick<SmokeNacosConfig, "namespace" | "group" | "dataId">): Promise<void> {
  const url = nacosUrl(endpoint, "/v1/cs/configs");
  url.searchParams.set("dataId", config.dataId);
  url.searchParams.set("group", config.group);
  if (config.namespace) url.searchParams.set("tenant", config.namespace);
  const response = await fetch(url, { method: "DELETE" });
  const text = await response.text();
  if (!response.ok || text.trim() !== "true") {
    throw new Error(`Nacos delete failed ${response.status}: ${text}`);
  }
}

export async function getNacosConfig(endpoint: SmokeNacosEndpoint, config: Pick<SmokeNacosConfig, "namespace" | "group" | "dataId">): Promise<string> {
  const url = nacosUrl(endpoint, "/v1/cs/configs");
  url.searchParams.set("dataId", config.dataId);
  url.searchParams.set("group", config.group);
  if (config.namespace) url.searchParams.set("tenant", config.namespace);
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Nacos get failed ${response.status}: ${text}`);
  }
  return text;
}

export async function waitForNacosContent(endpoint: SmokeNacosEndpoint, config: SmokeNacosConfig, timeoutMs = 20_000): Promise<string> {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const content = await getNacosConfig(endpoint, config);
      if (content.trim() === config.content.trim()) return content;
      lastError = `last content=${JSON.stringify(content)}`;
    } catch (error) {
      lastError = String(error);
    }
    await sleep(500);
  }
  throw new Error(`Nacos content did not converge for ${endpoint.role}/${config.dataId}: ${lastError}`);
}

export async function listNacosConfigs(
  endpoint: SmokeNacosEndpoint,
  request: { namespace: string; group: string; dataId: string; pageNo: number; pageSize: number }
): Promise<{ totalCount: number; pageNumber: number; pagesAvailable: number; pageItems: SmokeNacosConfigSummary[] }> {
  const url = nacosUrl(endpoint, "/v1/cs/configs");
  url.searchParams.set("search", "blur");
  url.searchParams.set("dataId", request.dataId);
  url.searchParams.set("group", request.group);
  url.searchParams.set("pageNo", String(request.pageNo));
  url.searchParams.set("pageSize", String(request.pageSize));
  if (request.namespace) url.searchParams.set("tenant", request.namespace);
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Nacos list failed ${response.status}: ${text}`);
  }
  const payload = JSON.parse(text) as {
    totalCount?: number;
    pageNumber?: number;
    pagesAvailable?: number;
    pageItems?: Array<{ dataId?: string; group?: string; content?: string; type?: string; lastModified?: string }>;
  };
  const items = await Promise.all(
    (payload.pageItems ?? []).map(async (item) => {
      const dataId = item.dataId ?? "";
      const group = item.group ?? request.group;
      return {
        dataId,
        group,
        content: dataId ? await getNacosConfig(endpoint, { namespace: request.namespace, group, dataId }) : item.content ?? "",
        configType: item.type ?? typeFromDataId(dataId),
        updateTime: item.lastModified ?? "",
      };
    })
  );
  return {
    totalCount: payload.totalCount ?? items.length,
    pageNumber: payload.pageNumber ?? request.pageNo,
    pagesAvailable: payload.pagesAvailable ?? 1,
    pageItems: items,
  };
}

export function configsForRole(role: SmokeNacosEndpoint["role"]): SmokeNacosConfig[] {
  const roleContent = {
    dev: "server:\n  port: 8080\nfeature: true\n",
    sandbox: "server:\n  port: 9090\nfeature: false\n",
    prod: "server:\n  port: 7070\nfeature: false\n",
  }[role];
  return [
    { namespace: "", group: "DEFAULT_GROUP", dataId: "smoke-app.yaml", content: roleContent, type: "yaml" },
    { namespace: "", group: "DEFAULT_GROUP", dataId: "smoke-secret.properties", content: `password=${role}-secret\ntoken=${role}-token\n`, type: "properties" },
    { namespace: "", group: "DEFAULT_GROUP", dataId: "smoke-json.json", content: JSON.stringify({ role, enabled: role === "dev" }, null, 2), type: "json" },
    { namespace: "", group: "DEFAULT_GROUP", dataId: "smoke-delete.yaml", content: `delete: ${role}\n`, type: "yaml" },
    { namespace: "", group: "DEFAULT_GROUP", dataId: "smoke-same.yaml", content: "same: true\n", type: "yaml" },
    ...(role === "dev" ? [{ namespace: "", group: "DEFAULT_GROUP", dataId: "smoke-only-dev.yaml", content: "only: dev\n", type: "yaml" }] : []),
  ];
}

function nacosUrl(endpoint: SmokeNacosEndpoint, apiPath: string): URL {
  const base = new URL(endpoint.baseUrl.endsWith("/") ? endpoint.baseUrl : `${endpoint.baseUrl}/`);
  const context = base.pathname.replace(/\/$/, "");
  return new URL(`${context}${apiPath}`, base.origin);
}

function typeFromDataId(dataId: string): string {
  if (dataId.endsWith(".json")) return "json";
  if (dataId.endsWith(".properties")) return "properties";
  if (dataId.endsWith(".yaml") || dataId.endsWith(".yml")) return "yaml";
  return "text";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

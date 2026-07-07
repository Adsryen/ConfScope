import type { SmokeConsulEndpoint } from "./workspace";

export interface SmokeConsulKV {
  key: string;
  value: string;
  modifyIndex: number;
}

interface ConsulKVPair {
  Key?: string;
  Value?: string | null;
  ModifyIndex?: number;
}

export const SMOKE_CONSUL_CONFIGS: SmokeConsulKV[] = [
  {
    key: "apps/order/app.yaml",
    value: "feature: true\nserver:\n  port: 8080\n",
    modifyIndex: 0,
  },
  {
    key: "apps/order/feature.json",
    value: '{"enabled":true,"source":"consul"}\n',
    modifyIndex: 0,
  },
  {
    key: "apps/order/runtime.properties",
    value: "feature.enabled=true\nserver.port=8080\n",
    modifyIndex: 0,
  },
  {
    key: "apps/billing/app.yaml",
    value: "feature: billing\n",
    modifyIndex: 0,
  },
];

export async function seedConsul(endpoint: SmokeConsulEndpoint): Promise<void> {
  for (const config of SMOKE_CONSUL_CONFIGS) {
    await retryConsul(() => putConsulKV(endpoint, config.key, config.value), `seed ${config.key}`);
  }
  await waitForConsulContent(endpoint, SMOKE_CONSUL_CONFIGS[0].key, SMOKE_CONSUL_CONFIGS[0].value);
}

export async function cleanupConsulSeed(endpoint: SmokeConsulEndpoint): Promise<void> {
  try {
    await deleteConsulPrefix(endpoint, "apps/");
  } catch {
    // 清理失败不覆盖真实测试结果。
  }
}

export async function waitForConsul(endpoint: SmokeConsulEndpoint, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const pairs = await listConsulKV(endpoint);
      if (pairs.length > 0) return;
      lastError = "Consul KV prefix is empty";
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Consul smoke container at ${endpoint.baseUrl}; lastError=${lastError}`);
}

export async function listConsulDatacenters(endpoint: SmokeConsulEndpoint): Promise<string[]> {
  const response = await fetch(new URL("/v1/catalog/datacenters", endpoint.baseUrl));
  if (!response.ok) {
    throw new Error(`Consul datacenter request failed ${response.status}: ${await response.text()}`);
  }
  const value = (await response.json()) as unknown;
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

export async function listConsulKV(endpoint: SmokeConsulEndpoint, prefix = endpoint.keyPrefix): Promise<SmokeConsulKV[]> {
  const url = consulKVURL(endpoint, prefix);
  url.searchParams.set("dc", endpoint.datacenter);
  url.searchParams.set("recurse", "true");
  const response = await fetch(url);
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Consul KV list failed ${response.status}: ${await response.text()}`);
  }
  const pairs = (await response.json()) as ConsulKVPair[];
  return pairs
    .filter((pair) => pair.Key && !pair.Key.endsWith("/") && pair.Value !== null && pair.Value !== undefined)
    .map((pair) => ({
      key: String(pair.Key),
      value: Buffer.from(String(pair.Value), "base64").toString("utf8"),
      modifyIndex: typeof pair.ModifyIndex === "number" ? pair.ModifyIndex : 0,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

export async function getConsulKV(endpoint: SmokeConsulEndpoint, key: string): Promise<SmokeConsulKV> {
  const url = consulKVURL(endpoint, key);
  url.searchParams.set("dc", endpoint.datacenter);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Consul KV get failed ${response.status}: ${await response.text()}`);
  }
  const pairs = (await response.json()) as ConsulKVPair[];
  const pair = pairs[0];
  if (!pair?.Key || pair.Value === null || pair.Value === undefined) {
    throw new Error(`Consul KV key not found: ${key}`);
  }
  return {
    key: String(pair.Key),
    value: Buffer.from(String(pair.Value), "base64").toString("utf8"),
    modifyIndex: typeof pair.ModifyIndex === "number" ? pair.ModifyIndex : 0,
  };
}

export async function getConsulKVContent(endpoint: SmokeConsulEndpoint, key: string): Promise<string> {
  return (await getConsulKV(endpoint, key)).value;
}

async function putConsulKV(endpoint: SmokeConsulEndpoint, key: string, content: string): Promise<void> {
  const url = consulKVURL(endpoint, key);
  url.searchParams.set("dc", endpoint.datacenter);
  const response = await fetch(url, { method: "PUT", body: content });
  if (!response.ok) {
    throw new Error(`Consul KV put failed ${response.status}: ${await response.text()}`);
  }
}

async function deleteConsulPrefix(endpoint: SmokeConsulEndpoint, prefix: string): Promise<void> {
  const url = consulKVURL(endpoint, prefix);
  url.searchParams.set("dc", endpoint.datacenter);
  url.searchParams.set("recurse", "true");
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Consul KV cleanup failed ${response.status}: ${await response.text()}`);
  }
}

async function waitForConsulContent(endpoint: SmokeConsulEndpoint, key: string, expected: string): Promise<void> {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < 60_000) {
    try {
      const content = await getConsulKVContent(endpoint, key);
      if (content === expected) return;
      lastError = `content=${JSON.stringify(content)}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Consul KV content ${key}; lastError=${lastError}`);
}

async function retryConsul(action: () => Promise<void>, label: string): Promise<void> {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < 60_000) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out during Consul ${label}; lastError=${lastError}`);
}

function consulKVURL(endpoint: SmokeConsulEndpoint, key: string): URL {
  const normalized = key.replace(/^\/+/g, "");
  const escaped = normalized
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return new URL(`/v1/kv/${escaped}`, endpoint.baseUrl);
}

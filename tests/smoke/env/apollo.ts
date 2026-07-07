import type { SmokeApolloEndpoint } from "./workspace";

export interface SmokeApolloItem {
  key: string;
  value: string;
  comment?: string;
  dataChangeLastModifiedTime?: string;
}

export interface SmokeApolloNamespace {
  appId: string;
  clusterName: string;
  namespaceName: string;
  format?: string;
  releaseKey?: string;
  items: SmokeApolloItem[];
}

export async function waitForApollo(endpoint: SmokeApolloEndpoint, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      await getApolloNamespace(endpoint);
      return;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for Apollo smoke container at ${endpoint.baseUrl}; lastError=${lastError}`);
}

export async function listApolloNamespaces(endpoint: SmokeApolloEndpoint): Promise<SmokeApolloNamespace[]> {
  return fetchApolloJSON<SmokeApolloNamespace[]>(endpoint, apolloPath(endpoint, "namespaces"));
}

export async function getApolloNamespace(endpoint: SmokeApolloEndpoint): Promise<SmokeApolloNamespace> {
  const namespace = await fetchApolloJSON<SmokeApolloNamespace>(endpoint, apolloPath(endpoint, `namespaces/${endpoint.namespaceName}`));
  if (!Array.isArray(namespace.items)) throw new Error("Apollo smoke namespace response missing items");
  return namespace;
}

export function apolloNamespaceContent(namespace: SmokeApolloNamespace): string {
  return [...namespace.items]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((item) => `${item.key}=${item.value}\n`)
    .join("");
}

export function apolloNamespaceUpdateTime(namespace: SmokeApolloNamespace): string {
  return namespace.items.reduce((latest, item) => {
    const value = item.dataChangeLastModifiedTime ?? "";
    return value > latest ? value : latest;
  }, "");
}

function apolloPath(endpoint: SmokeApolloEndpoint, suffix: string): string {
  return [
    "",
    "openapi",
    "v1",
    "envs",
    encodeURIComponent(endpoint.env),
    "apps",
    encodeURIComponent(endpoint.appId),
    "clusters",
    encodeURIComponent(endpoint.cluster),
    suffix,
  ].join("/");
}

async function fetchApolloJSON<T>(endpoint: SmokeApolloEndpoint, path: string): Promise<T> {
  const response = await fetch(new URL(path, endpoint.baseUrl), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: endpoint.token,
    },
  });
  if (!response.ok) {
    throw new Error(`Apollo smoke request failed ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

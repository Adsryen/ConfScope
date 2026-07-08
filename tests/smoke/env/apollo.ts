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

export async function upsertApolloItem(endpoint: SmokeApolloEndpoint, key: string, value: string, operator: string): Promise<void> {
  const path = apolloPath(endpoint, `namespaces/${endpoint.namespaceName}/items/${encodeURIComponent(key)}`);
  await fetchApolloJSON<unknown>(endpoint, path, {
    method: "PUT",
    query: new URLSearchParams({ createIfNotExists: "true" }),
    body: {
      key,
      value,
      comment: "ConfScope ApplyPlan",
      dataChangeLastModifiedBy: operator,
      dataChangeCreatedBy: operator,
    },
  });
}

export async function deleteApolloItem(endpoint: SmokeApolloEndpoint, key: string, operator: string): Promise<void> {
  const path = apolloPath(endpoint, `namespaces/${endpoint.namespaceName}/items/${encodeURIComponent(key)}`);
  await fetchApolloJSON<unknown>(endpoint, path, {
    method: "DELETE",
    query: new URLSearchParams({ operator }),
  });
}

export async function releaseApolloNamespace(
  endpoint: SmokeApolloEndpoint,
  releaseTitle: string,
  releaseComment: string,
  operator: string
): Promise<void> {
  await fetchApolloJSON<unknown>(endpoint, apolloPath(endpoint, `namespaces/${endpoint.namespaceName}/releases`), {
    method: "POST",
    body: {
      releaseTitle,
      releaseComment,
      releasedBy: operator,
    },
  });
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

interface ApolloRequestOptions {
  method?: string;
  query?: URLSearchParams;
  body?: Record<string, string>;
}

async function fetchApolloJSON<T>(endpoint: SmokeApolloEndpoint, path: string, options: ApolloRequestOptions = {}): Promise<T> {
  const url = new URL(path, endpoint.baseUrl);
  if (options.query) {
    for (const [key, value] of options.query) url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: endpoint.token,
  };
  let body: string | undefined;
  if (options.body) {
    headers["Content-Type"] = "application/json;charset=UTF-8";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      ...headers,
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`Apollo smoke request failed ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

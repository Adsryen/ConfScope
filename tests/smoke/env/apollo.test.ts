/**
 * @vitest-environment node
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  apolloNamespaceContent,
  deleteApolloItem,
  getApolloNamespace,
  listApolloNamespaces,
  releaseApolloNamespace,
  upsertApolloItem,
  waitForApollo,
} from "./apollo";
import type { SmokeApolloEndpoint } from "./workspace";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("Apollo smoke OpenAPI helper", () => {
  it("uses Apollo OpenAPI paths, Authorization header, and deterministic item serialization", async () => {
    const paths: string[] = [];
    const { endpoint } = await startServer((req, res) => {
      paths.push(req.url ?? "");
      if (req.headers.authorization !== "apollo-token") {
        json(res, 401, { message: "unauthorized" });
        return;
      }
      if (req.url === "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces") {
        json(res, 200, [
          {
            appId: "order-service",
            clusterName: "default",
            namespaceName: "application",
            format: "properties",
            items: [],
          },
        ]);
        return;
      }
      if (req.url === "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application") {
        json(res, 200, {
          appId: "order-service",
          clusterName: "default",
          namespaceName: "application",
          format: "properties",
          releaseKey: "release-1",
          items: [
            { key: "z.key", value: "last", dataChangeLastModifiedTime: "2026-07-07T10:02:00+08:00" },
            { key: "a.key", value: "first", dataChangeLastModifiedTime: "2026-07-07T10:01:00+08:00" },
          ],
        });
        return;
      }
      json(res, 404, { message: "not found" });
    });

    await waitForApollo(endpoint, 1_000);
    await expect(listApolloNamespaces(endpoint)).resolves.toHaveLength(1);
    const namespace = await getApolloNamespace(endpoint);

    expect(paths).toContain("/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces");
    expect(paths).toContain("/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application");
    expect(apolloNamespaceContent(namespace)).toBe("a.key=first\nz.key=last\n");
  });

  it("writes deletes and releases Apollo namespace items through OpenAPI", async () => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const items = new Map<string, string>([
      ["feature.enabled", "true"],
      ["server.port", "8080"],
    ]);
    let releaseKey = "release-1";
    const { endpoint } = await startServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      if (req.headers.authorization !== "apollo-token") {
        json(res, 401, { message: "unauthorized" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const namespacePath = "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application";
      if (req.method === "GET" && url.pathname === namespacePath) {
        json(res, 200, {
          appId: "order-service",
          clusterName: "default",
          namespaceName: "application",
          format: "properties",
          releaseKey,
          items: [...items.entries()].map(([key, value]) => ({ key, value })),
        });
        return;
      }
      if (req.method === "PUT" && url.pathname === `${namespacePath}/items/feature.enabled`) {
        const parsed = JSON.parse(body) as { value?: string };
        items.set("feature.enabled", String(parsed.value ?? ""));
        json(res, 200, { key: "feature.enabled", value: parsed.value });
        return;
      }
      if (req.method === "DELETE" && url.pathname === `${namespacePath}/items/server.port`) {
        items.delete("server.port");
        json(res, 200, { deleted: true });
        return;
      }
      if (req.method === "POST" && url.pathname === `${namespacePath}/releases`) {
        releaseKey = "release-2";
        json(res, 200, { releaseKey });
        return;
      }
      json(res, 404, { message: "not found" });
    });

    await upsertApolloItem(endpoint, "feature.enabled", "false", "confscope");
    await releaseApolloNamespace(endpoint, "ConfScope ApplyPlan", "plan smoke", "confscope");
    await deleteApolloItem(endpoint, "server.port", "confscope");
    await releaseApolloNamespace(endpoint, "ConfScope ApplyPlan", "plan smoke", "confscope");
    const namespace = await getApolloNamespace(endpoint);

    expect(apolloNamespaceContent(namespace)).toBe("feature.enabled=false\n");
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "PUT",
          url: "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application/items/feature.enabled?createIfNotExists=true",
          body: expect.stringContaining('"dataChangeLastModifiedBy":"confscope"'),
        }),
        expect.objectContaining({
          method: "DELETE",
          url: "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application/items/server.port?operator=confscope",
        }),
        expect.objectContaining({
          method: "POST",
          url: "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application/releases",
          body: expect.stringContaining('"releasedBy":"confscope"'),
        }),
      ])
    );
  });
});

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ endpoint: SmokeApolloEndpoint }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    endpoint: {
      containerName: "apollo-test",
      hostPort: address.port,
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "apollo-token",
      env: "DEV",
      appId: "order-service",
      cluster: "default",
      namespaceName: "application",
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

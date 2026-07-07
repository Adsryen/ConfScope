/**
 * @vitest-environment node
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { apolloNamespaceContent, getApolloNamespace, listApolloNamespaces, waitForApollo } from "./apollo";
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

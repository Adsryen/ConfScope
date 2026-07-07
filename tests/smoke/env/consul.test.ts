/**
 * @vitest-environment node
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { getConsulKVContent, listConsulKV, seedConsul, waitForConsul } from "./consul";
import type { SmokeConsulEndpoint } from "./workspace";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("Consul smoke KV helper", () => {
  it("uses Consul KV HTTP paths, dc query, and base64 value decoding", async () => {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    const { endpoint } = await startServer(async (req, res) => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", body: await readBody(req) });
      res.setHeader("Content-Type", "application/json");

      if (req.method === "PUT" && req.url === "/v1/kv/apps/order/app.yaml?dc=dc1") {
        res.end("true");
        return;
      }
      if (req.method === "PUT" && req.url === "/v1/kv/apps/order/feature.json?dc=dc1") {
        res.end("true");
        return;
      }
      if (req.method === "PUT" && req.url === "/v1/kv/apps/order/runtime.properties?dc=dc1") {
        res.end("true");
        return;
      }
      if (req.method === "PUT" && req.url === "/v1/kv/apps/billing/app.yaml?dc=dc1") {
        res.end("true");
        return;
      }
      if (req.method === "GET" && req.url === "/v1/kv/apps/order/?dc=dc1&recurse=true") {
        json(res, 200, [
          { Key: "apps/order/app.yaml", Value: Buffer.from("feature: true\nserver:\n  port: 8080\n").toString("base64"), ModifyIndex: 42 },
          { Key: "apps/order/feature.json", Value: Buffer.from('{"enabled":true}\n').toString("base64"), ModifyIndex: 43 },
        ]);
        return;
      }
      if (req.method === "GET" && req.url === "/v1/kv/apps/order/app.yaml?dc=dc1") {
        json(res, 200, [
          { Key: "apps/order/app.yaml", Value: Buffer.from("feature: true\nserver:\n  port: 8080\n").toString("base64"), ModifyIndex: 42 },
        ]);
        return;
      }
      json(res, 404, { message: "not found" });
    });

    await seedConsul(endpoint);
    await waitForConsul(endpoint, 1_000);
    await expect(listConsulKV(endpoint)).resolves.toMatchObject([
      { key: "apps/order/app.yaml", value: "feature: true\nserver:\n  port: 8080\n", modifyIndex: 42 },
      { key: "apps/order/feature.json", value: '{"enabled":true}\n', modifyIndex: 43 },
    ]);
    await expect(getConsulKVContent(endpoint, "apps/order/app.yaml")).resolves.toBe("feature: true\nserver:\n  port: 8080\n");

    expect(requests.some((request) => request.method === "PUT" && request.body.includes("feature: true"))).toBe(true);
    expect(requests.map((request) => request.url)).toContain("/v1/kv/apps/order/?dc=dc1&recurse=true");
  });
});

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<{ endpoint: SmokeConsulEndpoint }> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return {
    endpoint: {
      containerName: "consul-test",
      hostPort: address.port,
      baseUrl: `http://127.0.0.1:${address.port}`,
      datacenter: "dc1",
      keyPrefix: "apps/order/",
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.end(JSON.stringify(body));
}

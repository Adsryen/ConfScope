import { createServer } from "node:http";

const port = Number(process.env.APOLLO_SMOKE_PORT || "8070");
const token = process.env.APOLLO_SMOKE_TOKEN || "apollo-smoke-token";
const env = process.env.APOLLO_SMOKE_ENV || "DEV";
const appId = process.env.APOLLO_SMOKE_APP_ID || "order-service";
const cluster = process.env.APOLLO_SMOKE_CLUSTER || "default";
const namespaceName = process.env.APOLLO_SMOKE_NAMESPACE || "application";

const namespace = {
  appId,
  clusterName: cluster,
  namespaceName,
  format: "properties",
  releaseKey: "release-smoke-1",
  items: [
    { key: "server.port", value: "8080", dataChangeLastModifiedTime: "2026-07-07T10:01:00+08:00" },
    { key: "feature.enabled", value: "true", dataChangeLastModifiedTime: "2026-07-07T10:02:00+08:00" },
    { key: "z.last", value: "tail", dataChangeLastModifiedTime: "2026-07-07T10:00:00+08:00" },
  ],
};

const basePath = `/openapi/v1/envs/${encodeURIComponent(env)}/apps/${encodeURIComponent(appId)}/clusters/${encodeURIComponent(cluster)}/namespaces`;

createServer((req, res) => {
  if (req.headers.authorization !== token) {
    send(res, 401, { message: "unauthorized" });
    return;
  }
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === basePath) {
    send(res, 200, [namespace]);
    return;
  }
  if (req.method === "GET" && url.pathname === `${basePath}/${encodeURIComponent(namespaceName)}`) {
    send(res, 200, namespace);
    return;
  }
  send(res, 404, { message: "not found", path: url.pathname });
}).listen(port, "0.0.0.0");

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

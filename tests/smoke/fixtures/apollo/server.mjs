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

createServer(async (req, res) => {
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
  const itemPrefix = `${basePath}/${encodeURIComponent(namespaceName)}/items/`;
  if (req.method === "PUT" && url.pathname.startsWith(itemPrefix)) {
    if (url.searchParams.get("createIfNotExists") !== "true") {
      send(res, 400, { message: "createIfNotExists=true is required" });
      return;
    }
    const key = decodeURIComponent(url.pathname.slice(itemPrefix.length));
    const body = await readJSON(req);
    if (!key || String(body.key || "") !== key) {
      send(res, 400, { message: "item key mismatch" });
      return;
    }
    const existing = namespace.items.find((item) => item.key === key);
    const next = {
      key,
      value: String(body.value ?? ""),
      comment: String(body.comment ?? ""),
      dataChangeLastModifiedTime: new Date().toISOString(),
    };
    if (existing) Object.assign(existing, next);
    else namespace.items.push(next);
    send(res, 200, next);
    return;
  }
  if (req.method === "DELETE" && url.pathname.startsWith(itemPrefix)) {
    if (!url.searchParams.get("operator")) {
      send(res, 400, { message: "operator is required" });
      return;
    }
    const key = decodeURIComponent(url.pathname.slice(itemPrefix.length));
    const before = namespace.items.length;
    namespace.items = namespace.items.filter((item) => item.key !== key);
    if (namespace.items.length === before) {
      send(res, 404, { message: "item not found", key });
      return;
    }
    send(res, 200, { deleted: true, key });
    return;
  }
  if (req.method === "POST" && url.pathname === `${basePath}/${encodeURIComponent(namespaceName)}/releases`) {
    const body = await readJSON(req);
    if (!body.releasedBy) {
      send(res, 400, { message: "releasedBy is required" });
      return;
    }
    namespace.releaseKey = `release-smoke-${Date.now()}`;
    send(res, 200, {
      releaseKey: namespace.releaseKey,
      releaseTitle: body.releaseTitle,
      releaseComment: body.releaseComment,
      releasedBy: body.releasedBy,
    });
    return;
  }
  send(res, 404, { message: "not found", path: url.pathname });
}).listen(port, "0.0.0.0");

async function readJSON(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

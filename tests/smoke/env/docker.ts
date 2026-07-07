import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { SmokeNacosEndpoint, SmokeWebDAVEndpoint } from "./workspace";

export interface DockerRunOptions {
  image: string;
  name: string;
  args: string[];
}

export function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function createSmokeNetwork(): void {
  try {
    execFileSync("docker", ["network", "create", "confscope-smoke"], { stdio: "ignore" });
  } catch {
    // 网络已存在时继续复用；其他错误会在容器启动或 inspect 阶段暴露。
  }
}

export function removeContainer(name: string): void {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {
    // 清理不存在的容器不应阻塞下一轮 smoke。
  }
}

export function runDetachedContainer(options: DockerRunOptions): void {
  removeContainer(options.name);
  execFileSync("docker", ["run", "-d", "--name", options.name, ...options.args, options.image], { stdio: "pipe" });
}

export function startNacosContainer(endpoint: SmokeNacosEndpoint): void {
  runDetachedContainer({
    name: endpoint.containerName,
    image: "nacos/nacos-server:v2.3.2",
    args: [
      "--network",
      "confscope-smoke",
      "-p",
      `127.0.0.1:${endpoint.hostPort}:8848`,
      "-e",
      "MODE=standalone",
      "-e",
      "NACOS_AUTH_ENABLE=false",
    ],
  });
}

export function webDAVContainerOptions(endpoint: SmokeWebDAVEndpoint, dataDir: string): DockerRunOptions {
  return {
    name: endpoint.containerName,
    image: "node:22-alpine",
    args: [
      "--network",
      "confscope-smoke",
      "-p",
      `127.0.0.1:${endpoint.hostPort}:8080`,
      "-v",
      `${dataDir}:/data`,
      "-e",
      `AUTH_USER=${endpoint.username}`,
      "-e",
      `AUTH_PASS=${endpoint.password}`,
      "node",
      "-e",
      webDAVServerScript(),
    ],
  };
}

export function startWebDAVContainer(endpoint: SmokeWebDAVEndpoint, dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  runDetachedContainer(webDAVContainerOptions(endpoint, dataDir));
}

export async function waitForWebDAV(endpoint: SmokeWebDAVEndpoint, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(new URL(endpoint.rootPath, endpoint.baseUrl), {
        method: "MKCOL",
        headers: {
          Authorization: `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64")}`,
        },
      });
      if ([200, 201, 204, 405].includes(response.status)) return;
      lastError = `HTTP ${response.status}: ${await response.text()}`;
    } catch (error) {
      lastError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for WebDAV smoke container at ${endpoint.baseUrl}; lastError=${lastError}`);
}

export function cleanupSmokeContainers(): void {
  for (const name of [
    "confscope-smoke-nacos-dev",
    "confscope-smoke-nacos-sandbox",
    "confscope-smoke-nacos-prod",
    "confscope-smoke-webdav",
    "confscope-smoke-sshd",
  ]) {
    removeContainer(name);
  }
  try {
    execFileSync("docker", ["network", "rm", "confscope-smoke"], { stdio: "ignore" });
  } catch {
    // 其他进程仍在使用网络时保留，由报告记录当前状态。
  }
}

function webDAVServerScript(): string {
  return `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = "/data";
const user = process.env.AUTH_USER || "smoke";
const pass = process.env.AUTH_PASS || "smoke-pass";
const expectedAuth = "Basic " + Buffer.from(user + ":" + pass).toString("base64");
function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\\"": "&quot;", "'": "&apos;" }[ch]));
}
function send(res, status, body, headers) {
  res.writeHead(status, headers || {});
  res.end(body || "");
}
function requestPath(req) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const decoded = decodeURIComponent(url.pathname);
  const full = path.resolve(root, "." + decoded);
  if (!full.startsWith(root)) throw new Error("path escapes root");
  return { decoded, full };
}
function href(base, name) {
  const value = path.posix.join(base, name || "");
  return value.startsWith("/") ? value : "/" + value;
}
http.createServer((req, res) => {
  if (req.headers.authorization !== expectedAuth) {
    send(res, 401, "unauthorized", { "WWW-Authenticate": "Basic realm=\\"ConfScope Smoke WebDAV\\"" });
    return;
  }
  let info;
  try {
    info = requestPath(req);
  } catch (error) {
    send(res, 400, String(error));
    return;
  }
  if (req.method === "MKCOL") {
    fs.mkdirSync(info.full, { recursive: true });
    send(res, 201);
    return;
  }
  if (req.method === "PUT") {
    fs.mkdirSync(path.dirname(info.full), { recursive: true });
    const out = fs.createWriteStream(info.full);
    req.pipe(out);
    out.on("finish", () => send(res, 201));
    out.on("error", (error) => send(res, 500, String(error)));
    return;
  }
  if (req.method === "GET") {
    if (!fs.existsSync(info.full) || !fs.statSync(info.full).isFile()) {
      send(res, 404, "not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    fs.createReadStream(info.full).pipe(res);
    return;
  }
  if (req.method === "PROPFIND") {
    if (!fs.existsSync(info.full) || !fs.statSync(info.full).isDirectory()) {
      send(res, 404, "not found");
      return;
    }
    const entries = fs.readdirSync(info.full, { withFileTypes: true });
    const responses = [
      '<d:response><d:href>' + escapeXml(info.decoded.endsWith("/") ? info.decoded : info.decoded + "/") + '</d:href><d:propstat><d:prop><d:resourcetype><d:collection /></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
      ...entries.map((entry) => {
        const full = path.join(info.full, entry.name);
        const stat = fs.statSync(full);
        const resource = entry.isDirectory() ? '<d:resourcetype><d:collection /></d:resourcetype>' : '<d:resourcetype />';
        return '<d:response><d:href>' + escapeXml(href(info.decoded, entry.name)) + '</d:href><d:propstat><d:prop>' + resource + '<d:getcontentlength>' + stat.size + '</d:getcontentlength><d:getlastmodified>' + stat.mtime.toUTCString() + '</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
      })
    ].join("");
    send(res, 207, '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">' + responses + '</d:multistatus>', { "Content-Type": "application/xml" });
    return;
  }
  send(res, 405, "method not allowed");
}).listen(8080, "0.0.0.0");
`;
}

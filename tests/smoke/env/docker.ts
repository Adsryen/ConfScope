import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { SmokeApolloEndpoint, SmokeNacosEndpoint, SmokeWebDAVEndpoint } from "./workspace";

export interface DockerRunOptions {
  image: string;
  name: string;
  args: string[];
  command?: string[];
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
  execFileSync("docker", ["run", "-d", "--name", options.name, ...options.args, options.image, ...(options.command ?? [])], {
    stdio: "pipe",
  });
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

export function apolloContainerOptions(endpoint: SmokeApolloEndpoint, serverFile: string): DockerRunOptions {
  return {
    name: endpoint.containerName,
    image: "node:20-alpine",
    args: [
      "--network",
      "confscope-smoke",
      "-p",
      `127.0.0.1:${endpoint.hostPort}:8070`,
      "-v",
      `${serverFile}:/srv/apollo-server.mjs:ro`,
      "-e",
      `APOLLO_SMOKE_TOKEN=${endpoint.token}`,
      "-e",
      `APOLLO_SMOKE_ENV=${endpoint.env}`,
      "-e",
      `APOLLO_SMOKE_APP_ID=${endpoint.appId}`,
      "-e",
      `APOLLO_SMOKE_CLUSTER=${endpoint.cluster}`,
      "-e",
      `APOLLO_SMOKE_NAMESPACE=${endpoint.namespaceName}`,
    ],
    command: ["node", "/srv/apollo-server.mjs"],
  };
}

export function startApolloContainer(endpoint: SmokeApolloEndpoint, serverFile: string): void {
  runDetachedContainer(apolloContainerOptions(endpoint, serverFile));
}

export function webDAVContainerOptions(endpoint: SmokeWebDAVEndpoint, dataDir: string): DockerRunOptions {
  return {
    name: endpoint.containerName,
    image: "bytemark/webdav",
    args: [
      "--network",
      "confscope-smoke",
      "-p",
      `127.0.0.1:${endpoint.hostPort}:80`,
      "-v",
      `${dataDir}:/var/lib/dav`,
      "-e",
      "AUTH_TYPE=Basic",
      "-e",
      `USERNAME=${endpoint.username}`,
      "-e",
      `PASSWORD=${endpoint.password}`,
      "-e",
      "LOCATION=/",
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
    "confscope-smoke-apollo",
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

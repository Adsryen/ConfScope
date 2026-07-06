import { execFileSync } from "node:child_process";
import type { SmokeNacosEndpoint } from "./workspace";

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

export function cleanupSmokeContainers(): void {
  for (const name of [
    "confscope-smoke-nacos-dev",
    "confscope-smoke-nacos-sandbox",
    "confscope-smoke-nacos-prod",
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

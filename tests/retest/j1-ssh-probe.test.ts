/**
 * J1：SSH 隧道真机握手验证
 *
 * 验证目标（PRD J1「建立/测试/停止隧道」）：
 *   1. 真实 SSH 握手：ssh2 Client 连接容器 sshd（密钥认证）→ ready
 *   2. exec 通道：在远端执行 `echo hello` → 收到 stdout
 *   3. 隧道转发：forwardOut 经 SSH 到达 Nacos-A → 真的读回 HTTP 响应字节
 *
 * 前置条件（常驻容器）：
 *   confscope-retest-nacos-a  -p 19848:8848
 *   confscope-retest-sshd2    -p 2223:22  user=retuser  密钥=tests/retest/ssh-keys/id_ed25519
 *   私钥被 .gitignore 排除（.gitignore:104），不存在时本用例直接 skip，不冒充通过。
 *
 * 为什么转发目标是 172.17.0.1 而不是 127.0.0.1（2026-10-27 同一密钥实测）：
 *   forwardOut -> 127.0.0.1:19848  = (SSH) Channel open failure: Connection refused
 *   forwardOut -> 172.17.0.1:19848 = HTTP/1.1 200 + Vary: Access-Control-Request-Me…（真字节）
 *   隧道本身没问题：127.0.0.1 是 sshd 容器自己的 loopback，上面没有 Nacos；
 *   172.17.0.1 是 docker bridge 网关，Nacos-A 就映射在宿主机 19848 上。
 *   loopback 那一路只打印读数、不断言必失败——它是拓扑事实，不是产品契约。
 *
 * UI 侧「测试 SSH」链路（retest 桥 mock 成功/失败路径）已由 80-pages.spec.ts S5 覆盖。
 * 本文件补真实握手 + 隧道转发断言，构成 J1 完整证据链。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "ssh2";
import { loadRetestState } from "./state.js";

const PRIVATE_KEY_PATH = path.resolve(
  __dirname,
  loadRetestState().ssh?.privateKeyPath ?? "ssh-keys/id_ed25519",
);
const HAS_PRIVATE_KEY = fs.existsSync(PRIVATE_KEY_PATH);

// confscope-retest-nacos-a 的宿主机映射端口（docker bridge 网关侧）。
const TUNNEL_PROBE_HOST = "172.17.0.1";
const NACOS_HOST_PORT = 19848;
const NACOS_PROBE_PATH = "/nacos/v1/console/namespaces";

if (!HAS_PRIVATE_KEY) {
  console.log(
    `[j1] 跳过真实握手：私钥不存在 ${PRIVATE_KEY_PATH}（被 .gitignore 排除，只在开发机上签出）`,
  );
}

function sshConnect(ssh: { host: string; port: number; username: string }) {
  return new Promise<Client>((resolve, reject) => {
    const c = new Client();
    c.on("ready", () => resolve(c));
    c.on("error", reject);
    c.connect({
      host: ssh.host,
      port: ssh.port,
      username: ssh.username,
      privateKey: fs.readFileSync(PRIVATE_KEY_PATH),
      readyTimeout: 10_000,
    });
  });
}

async function sshConnectWithHint(ssh: { host: string; port: number; username: string }) {
  try {
    return await sshConnect(ssh);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `SSH 连接 ${ssh.host}:${ssh.port} 失败：${msg}` +
        `（confscope-retest-sshd2 是否在跑？2223 端口是否映射？私钥 ${PRIVATE_KEY_PATH} 是否属于该容器？）`,
    );
  }
}

function sshExec(c: Client, cmd: string) {
  return new Promise<string>((resolve, reject) => {
    c.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("data", (d: Buffer) => (out += d.toString()));
      stream.stderr.on("data", (d: Buffer) => (out += d.toString()));
      stream.on("close", () => resolve(out));
      stream.on("error", reject);
    });
  });
}

/**
 * 经 SSH 直连通道发一个裸 HTTP 请求并读回响应字节。
 * 通道打开只证明 sshd 愿意转发，读到状态行 + 头部之后的 body 才算「目标端口真有服务、字节真回来了」。
 */
function sshForwardHttp(
  c: Client,
  host: string,
  port: number,
  requestPath: string,
  timeoutMs = 8_000,
) {
  return new Promise<{ payload: string }>((resolve, reject) => {
    c.forwardOut("127.0.0.1", 0, host, port, (err, sock) => {
      if (err) {
        reject(new Error(`forwardOut ${host}:${port} 通道未建立：${err.message}`));
        return;
      }
      let payload = "";
      let settled = false;
      const complete = () => {
        const headerEnd = payload.indexOf("\r\n\r\n");
        return /^HTTP\/1\.[01] \d{3}/.test(payload) && headerEnd > 0 && payload.length > headerEnd + 4;
      };
      const finish = (failure?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); // finish 只在异步回调里被调到，那时 timer 早已初始化
        sock.close();
        if (failure) reject(failure);
        else resolve({ payload });
      };
      const timer = setTimeout(() => {
        finish(
          complete()
            ? undefined
            : new Error(`${host}:${port} 在 ${timeoutMs}ms 内没读到完整 HTTP 响应（已收 ${payload.length} 字节）`),
        );
      }, timeoutMs);
      sock.on("data", (d: Buffer) => {
        payload += d.toString("utf8");
        if (complete()) finish();
      });
      sock.on("error", (e: Error) =>
        finish(complete() ? undefined : new Error(`${host}:${port} 通道错误：${e.message}`)),
      );
      sock.on("close", () =>
        finish(
          complete()
            ? undefined
            : new Error(`${host}:${port} 通道关闭但没读到完整 HTTP 响应（已收 ${payload.length} 字节）`),
        ),
      );
      sock.write(
        `GET ${requestPath} HTTP/1.1\r\nHost: ${host}:${port}\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
      );
    });
  });
}

describe("J1 SSH 隧道真机握手", () => {
  it.skipIf(!HAS_PRIVATE_KEY)(
    "密钥认证握手 + exec 通道 + 隧道转发读回 HTTP 字节",
    async () => {
      const state = loadRetestState();
      expect(state.ssh).toBeDefined();

      const c = await sshConnectWithHint(state.ssh!);
      try {
        // 1. exec 通道
        const out = await sshExec(c, "echo hello J1-SSH-OK");
        expect(out).toContain("J1-SSH-OK");

        // 2. 隧道转发：经 SSH 跳到 docker bridge 网关上的 Nacos-A，必须真的读回响应字节
        const res = await sshForwardHttp(c, TUNNEL_PROBE_HOST, NACOS_HOST_PORT, NACOS_PROBE_PATH);
        const statusLine = res.payload.split("\r\n")[0];
        const bytes = Buffer.byteLength(res.payload);
        console.log(`  tunnel ${TUNNEL_PROBE_HOST}:${NACOS_HOST_PORT} -> ${statusLine}（${bytes} 字节）`);
        expect(statusLine).toMatch(/^HTTP\/1\.[01] 200/);
        expect(bytes).toBeGreaterThan(100);
        // 命名空间读数与 A 侧真实数据同源：隧道里拿回来的就是 Nacos-A 的内容，不是随便一个端口横幅
        expect(res.payload).toContain("retest-dev");

        // 3. 只留证据、不断言：sshd 容器自己的 loopback 上没有 Nacos（拓扑相关，不是出门条件）
        const loopback = await sshForwardHttp(
          c,
          "127.0.0.1",
          NACOS_HOST_PORT,
          NACOS_PROBE_PATH,
          3_000,
        )
          .then((r) => `居然成功了：${r.payload.split("\r\n")[0]}`)
          .catch((e: Error) => `预期内失败：${e.message}`);
        console.log(`  tunnel 127.0.0.1:${NACOS_HOST_PORT} -> ${loopback}`);
      } finally {
        c.end();
      }
    },
    30_000,
  );
});

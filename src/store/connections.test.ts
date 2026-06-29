import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionDisplayLabel,
  deleteConnection,
  loadConnections,
  renameEnvironment,
  renameProject,
  upsertConnection,
  type Connection,
} from "./connections";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

describe("connection store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-27T00:00:00Z"));
    vi.spyOn(Math, "random").mockReturnValue(0.123456);
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("returns an empty list when storage is empty or malformed", () => {
    expect(loadConnections()).toEqual([]);

    localStorage.setItem("cs.connections", "{bad json");

    expect(loadConnections()).toEqual([]);
  });

  it("creates a connection with a generated id", () => {
    const created = upsertConnection({
      name: "dev",
      baseUrl: "http://localhost:8848/nacos",
      username: "nacos",
      password: "nacos",
      defaultNamespace: "",
    });

    expect(created.id).toMatch(/^c_/);
    expect(created.projectName).toBe("默认项目");
    expect(created.environmentName).toBe("未分组");
    expect(created.sourceName).toBe("dev");
    expect(created.sourceType).toBe("nacos");
    expect(loadConnections()).toEqual([created]);
  });

  it("persists project environment and source metadata", () => {
    const created = upsertConnection({
      name: "prod-public",
      projectName: "订单系统",
      environmentName: "生产",
      sourceName: "云上公网",
      isDefaultSource: true,
      baseUrl: "https://prod.example.com/nacos",
      username: "nacos",
      password: "nacos",
      defaultNamespace: "",
    });

    expect(loadConnections()[0]).toEqual(created);
    expect(connectionDisplayLabel(created)).toBe("订单系统 / 生产 / 云上公网");
  });

  it("updates an existing connection in place", () => {
    const created = upsertConnection({
      name: "dev",
      baseUrl: "http://localhost:8848/nacos",
      username: "nacos",
      password: "nacos",
      defaultNamespace: "",
    });

    const updated = upsertConnection({ ...created, name: "prod", defaultNamespace: "public" });

    expect(updated.id).toBe(created.id);
    expect(loadConnections()).toEqual([updated]);
  });

  it("deletes a connection by id", () => {
    vi.mocked(Math.random).mockReturnValueOnce(0.123456).mockReturnValueOnce(0.654321);
    const first = upsertConnection({
      name: "dev",
      baseUrl: "http://localhost:8848/nacos",
      username: "nacos",
      password: "nacos",
      defaultNamespace: "",
    });
    const second = upsertConnection({
      name: "prod",
      baseUrl: "http://prod:8848/nacos",
      username: "",
      password: "",
      defaultNamespace: "public",
    });

    deleteConnection(first.id);

    expect(loadConnections()).toEqual([second]);
  });

  it("preserves SSH config when persisting", () => {
    const conn: Omit<Connection, "id"> = {
      name: "ssh",
      baseUrl: "http://nacos.internal:8848/nacos",
      username: "",
      password: "",
      defaultNamespace: "",
      sshConfig: {
        host: "jump.example.com",
        port: 22,
        username: "ops",
        authType: "password",
        password: "secret",
      },
    };

    const created = upsertConnection(conn);

    expect(loadConnections()[0]).toEqual(created);
  });

  it("preserves reusable SSH profile references when persisting", () => {
    const created = upsertConnection({
      name: "ssh-profile",
      baseUrl: "http://nacos.internal:8848/nacos",
      username: "",
      password: "",
      defaultNamespace: "",
      sshProfileId: "ssh-prod",
    });

    expect(loadConnections()[0]).toEqual(created);
    expect(loadConnections()[0]).toEqual(expect.objectContaining({ sshProfileId: "ssh-prod" }));
  });

  it("preserves local snapshot force and validation metadata", () => {
    const created = upsertConnection({
      name: "local-snapshot",
      sourceName: "本地快照",
      sourceType: "local-snapshot",
      localPath: "C:\\backup\\loose",
      forceLocalSnapshot: true,
      localValidation: {
        valid: false,
        message: "未找到快照清单或标准目录结构",
        configCount: 1,
        checkedAt: "2026-06-29T00:00:00Z",
      },
      baseUrl: "C:\\backup\\loose",
      username: "",
      password: "",
      defaultNamespace: "",
    });

    expect(loadConnections()[0]).toEqual(created);
    expect(loadConnections()[0]).toEqual(
      expect.objectContaining({
        forceLocalSnapshot: true,
        localValidation: expect.objectContaining({
          valid: false,
          message: "未找到快照清单或标准目录结构",
        }),
      })
    );
  });

  it("renames a project across its connections", () => {
    const first = upsertConnection({
      name: "prod-public",
      projectName: "订单系统",
      environmentName: "生产",
      sourceName: "公网",
      baseUrl: "https://prod.example.com/nacos",
      username: "nacos",
      password: "nacos",
      defaultNamespace: "",
    });
    const second = upsertConnection({
      name: "test-intranet",
      projectName: "订单系统",
      environmentName: "测试",
      sourceName: "内网",
      baseUrl: "https://test.example.com/nacos",
      username: "nacos",
      password: "nacos",
      defaultNamespace: "",
    });

    const next = renameProject("订单系统", "交易平台");

    expect(next).toEqual([
      expect.objectContaining({ id: first.id, projectName: "交易平台" }),
      expect.objectContaining({ id: second.id, projectName: "交易平台" }),
    ]);
    expect(loadConnections().map((conn) => conn.projectName)).toEqual(["交易平台", "交易平台"]);
  });

  it("renames an environment only within the selected project", () => {
    const order = upsertConnection({
      name: "order-prod",
      projectName: "订单系统",
      environmentName: "生产",
      sourceName: "公网",
      baseUrl: "https://order.example.com/nacos",
      username: "nacos",
      password: "nacos",
      defaultNamespace: "",
    });
    const member = upsertConnection({
      name: "member-prod",
      projectName: "会员系统",
      environmentName: "生产",
      sourceName: "公网",
      baseUrl: "https://member.example.com/nacos",
      username: "nacos",
      password: "nacos",
      defaultNamespace: "",
    });

    renameEnvironment("订单系统", "生产", "线上");

    expect(loadConnections()).toEqual([
      expect.objectContaining({ id: order.id, environmentName: "线上" }),
      expect.objectContaining({ id: member.id, environmentName: "生产" }),
    ]);
  });
});

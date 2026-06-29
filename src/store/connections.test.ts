import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectionDisplayLabel,
  deleteConnection,
  loadConnections,
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
});

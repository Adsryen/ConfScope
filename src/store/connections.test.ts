import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteConnection, loadConnections, upsertConnection, type Connection } from "./connections";

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
    expect(loadConnections()).toEqual([created]);
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

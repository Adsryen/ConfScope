/**
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSmokeAppBinding } from "./appBinding";
import { createSmokeWorkspace, type SmokeState } from "../env/workspace";

const roots: string[] = [];

function smokeState(): SmokeState {
  const projectRoot = mkdtempSync(join(tmpdir(), "confscope-smoke-binding-"));
  roots.push(projectRoot);
  const workspace = createSmokeWorkspace({ projectRoot, runId: "20260707-120000" });
  mkdirSync(workspace.appBackupsDir, { recursive: true });
  mkdirSync(workspace.webdavDir, { recursive: true });
  return {
    ...workspace,
    fixtures: {
      strictPublic: join(projectRoot, "strict"),
      legacyPublic: join(projectRoot, "legacy"),
      invalidEmpty: join(projectRoot, "invalid"),
    },
  };
}

describe("createSmokeAppBinding app data backup methods", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes encrypted local app data backups and decrypts them with the correct password", async () => {
    const state = smokeState();
    const invoke = createSmokeAppBinding(state);
    const path = join(state.appBackupsDir, "app.csbackup");
    const plaintext = JSON.stringify({ schemaVersion: 1, data: { connections: [{ password: "secret" }] } });
    const meta = { appVersion: "1.4.2", sourcePlatform: "windows", createdAt: "2026-07-07T08:00:00.000Z" };

    await invoke("WriteAppDataBackupFile", [path, plaintext, "backup-pass", meta]);
    const bytes = readFileSync(path, "utf8");

    expect(bytes).not.toContain("connections");
    expect(bytes).not.toContain("secret");
    await expect(invoke("ReadAppDataBackupFile", [path, "backup-pass"])).resolves.toMatchObject({ plaintextJson: plaintext });
    await expect(invoke("ReadAppDataBackupFile", [path, "wrong-pass"])).rejects.toThrow();
  });

  it("parses WebDAV multistatus XML with generic namespace prefixes", async () => {
    const state = smokeState();
    const invoke = createSmokeAppBinding(state);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/confscope/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection /></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/confscope/confscope-app-data-20260707-102829.csbackup</D:href>
    <D:propstat>
      <D:prop>
        <D:getcontentlength>7147</D:getcontentlength>
        <D:getlastmodified>Tue, 07 Jul 2026 10:28:29 GMT</D:getlastmodified>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`,
          { status: 207, headers: { "Content-Type": "application/xml" } }
        )
      )
    );

    await expect(
      invoke("ListAppDataWebDAVBackups", [
        {
          enabled: true,
          url: state.webdav.baseUrl,
          username: state.webdav.username,
          password: state.webdav.password,
          rootPath: state.webdav.rootPath,
        },
      ])
    ).resolves.toEqual([
      {
        name: "confscope-app-data-20260707-102829.csbackup",
        path: "/confscope/confscope-app-data-20260707-102829.csbackup",
        size: 7147,
        modifiedAt: "Tue, 07 Jul 2026 10:28:29 GMT",
      },
    ]);
  });

  it("uploads lists and imports encrypted config snapshot packages through WebDAV", async () => {
    const state = smokeState();
    const invoke = createSmokeAppBinding(state);
    const remoteFiles = new Map<string, Buffer>();
    remoteFiles.set("/confscope/snapshots/app.csbackup", Buffer.from("app backup"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (method === "MKCOL") {
          return new Response("", { status: 201 });
        }
        if (method === "PUT") {
          remoteFiles.set(url.pathname, Buffer.from(await new Response(init?.body).arrayBuffer()));
          return new Response("", { status: 201 });
        }
        if (method === "GET") {
          const body = remoteFiles.get(url.pathname);
          return body ? new Response(body) : new Response("not found", { status: 404 });
        }
        if (method === "PROPFIND") {
          const responses = [...remoteFiles.entries()]
            .map(
              ([remotePath, body]) =>
                `<D:response><D:href>${remotePath}</D:href><D:propstat><D:prop><D:getcontentlength>${body.length}</D:getcontentlength><D:getlastmodified>Wed, 08 Jul 2026 08:00:00 GMT</D:getlastmodified></D:prop></D:propstat></D:response>`
            )
            .join("");
          return new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`, { status: 207 });
        }
        return new Response("bad method", { status: 405 });
      })
    );
    const target = {
      enabled: true,
      url: state.webdav.baseUrl,
      username: state.webdav.username,
      password: state.webdav.password,
      rootPath: "/confscope/snapshots",
    };
    const snapshot = await invoke("CreateSnapshot", [
      { provider: "nacos", connectionId: "conn-dev", connectionName: "dev-nacos", namespace: "public", namespaceId: "public" },
      [{ namespace: "public", group: "DEFAULT_GROUP", dataId: "app.yaml", content: "password: super-secret\n", configType: "yaml" }],
    ]);

    const remote = await invoke("UploadSnapshotWebDAVPackage", [target, (snapshot as { id: string }).id, "snapshot-pass"]);

    expect(remote).toMatchObject({ name: expect.stringMatching(/\.cssnapshot$/), snapshotId: (snapshot as { id: string }).id });
    const uploaded = remoteFiles.get((remote as { path: string }).path)?.toString("utf8") ?? "";
    expect(uploaded).not.toContain("super-secret");
    expect(uploaded).toContain("confscope.config-snapshot");

    await expect(invoke("ListSnapshotWebDAVPackages", [target])).resolves.toEqual([
      expect.objectContaining({ name: (remote as { name: string }).name, snapshotId: (snapshot as { id: string }).id }),
    ]);

    const imported = await invoke("ImportSnapshotWebDAVPackage", [target, (remote as { path: string }).path, "snapshot-pass"]);

    expect(imported).toMatchObject({ remoteSnapshotId: (snapshot as { id: string }).id, importedFrom: { remotePath: (remote as { path: string }).path } });
    expect((imported as { id: string }).id).not.toBe((snapshot as { id: string }).id);
    await expect(invoke("ImportSnapshotWebDAVPackage", [target, (remote as { path: string }).path, "wrong-pass"])).rejects.toThrow();
  });

  it("creates snapshot files for provider configs whose groups and dataIds contain slashes", async () => {
    const state = smokeState();
    const invoke = createSmokeAppBinding(state);

    const snapshot = (await invoke("CreateSnapshot", [
      { provider: "consul", connectionId: "smoke-consul", connectionName: "Consul KV", namespace: "dc1", namespaceId: "dc1" },
      [{ namespace: "dc1", group: "apps/order/", dataId: "apps/order/app.yaml", content: "feature: snapshot\n", configType: "yaml" }],
    ])) as { path: string };

    expect(readFileSync(join(snapshot.path, "configs", "dc1", "apps", "order", "apps", "order", "app.yaml"), "utf8")).toBe(
      "feature: snapshot\n"
    );
  });

  it("routes Apollo ConfigCenter bridge calls through Apollo OpenAPI", async () => {
    const state = smokeState();
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces")) {
        return new Response(
          JSON.stringify([
            {
              appId: "order-service",
              clusterName: "default",
              namespaceName: "application",
              format: "properties",
              items: [],
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.endsWith("/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application")) {
        return new Response(
          JSON.stringify({
            appId: "order-service",
            clusterName: "default",
            namespaceName: "application",
            format: "properties",
            releaseKey: "release-1",
            items: [
              { key: "feature.enabled", value: "true", dataChangeLastModifiedTime: "2026-07-07T10:02:00+08:00" },
              { key: "server.port", value: "8080", dataChangeLastModifiedTime: "2026-07-07T10:01:00+08:00" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const invoke = createSmokeAppBinding(state);
    const profile = {
      id: "smoke-apollo",
      name: "Apollo OpenAPI",
      provider: "apollo",
      baseUrl: state.apollo.baseUrl,
      accessToken: state.apollo.token,
      apolloEnv: state.apollo.env,
      apolloAppId: state.apollo.appId,
      apolloCluster: state.apollo.cluster,
      apolloNamespaceName: state.apollo.namespaceName,
    };

    await expect(invoke("ConfigCenterTestConnection", [profile])).resolves.toBeUndefined();
    await expect(invoke("ConfigCenterListNamespaces", [profile])).resolves.toEqual([
      { id: "order-service", name: "order-service / DEV / default", configCount: 1, kind: 0 },
    ]);
    await expect(
      invoke("ConfigCenterListConfigs", [profile, { namespace: "order-service", group: "", dataId: "", pageNo: 1, pageSize: 20 }])
    ).resolves.toMatchObject({
      totalCount: 1,
      pageItems: [
        {
          content: "",
          format: "properties",
          ref: { provider: "apollo", namespace: "order-service", group: "default", dataId: "application" },
        },
      ],
    });
    await expect(
      invoke("ConfigCenterGetConfig", [
        profile,
        { provider: "apollo", connectionId: "smoke-apollo", namespace: "order-service", group: "default", dataId: "application" },
      ])
    ).resolves.toMatchObject({
      content: "feature.enabled=true\nserver.port=8080\n",
      format: "properties",
      version: "release-1",
      source: "apollo:DEV/order-service/default/application",
    });
  });

  it("routes Apollo ApplyPlan bridge writes through item APIs and releases before read-back", async () => {
    const state = smokeState();
    const items = new Map<string, string>([
      ["feature.enabled", "true"],
      ["server.port", "8080"],
    ]);
    let releaseKey = "release-1";
    const requests: Array<{ method: string; path: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        requests.push({ method, path: `${url.pathname}${url.search}` });
        const namespacePath = "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application";
        if (url.pathname === namespacePath && method === "GET") {
          return new Response(
            JSON.stringify({
              appId: "order-service",
              clusterName: "default",
              namespaceName: "application",
              format: "properties",
              releaseKey,
              items: [...items.entries()].map(([key, value]) => ({ key, value })),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.pathname === `${namespacePath}/items/feature.enabled` && method === "PUT") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { value?: string };
          items.set("feature.enabled", String(body.value ?? ""));
          return new Response(JSON.stringify({ key: "feature.enabled", value: body.value }), { status: 200 });
        }
        if (url.pathname === `${namespacePath}/items/server.port` && method === "DELETE") {
          items.delete("server.port");
          return new Response(JSON.stringify({ deleted: true }), { status: 200 });
        }
        if (url.pathname === `${namespacePath}/releases` && method === "POST") {
          releaseKey = `release-${Number(releaseKey.split("-")[1] ?? 1) + 1}`;
          return new Response(JSON.stringify({ releaseKey }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      })
    );
    const invoke = createSmokeAppBinding(state);
    const profile = {
      id: "smoke-apollo",
      name: "Apollo OpenAPI",
      provider: "apollo",
      baseUrl: state.apollo.baseUrl,
      accessToken: state.apollo.token,
      apolloEnv: state.apollo.env,
      apolloAppId: state.apollo.appId,
      apolloCluster: state.apollo.cluster,
      apolloNamespaceName: state.apollo.namespaceName,
    };
    const ref = {
      provider: "apollo",
      connectionId: "smoke-apollo",
      namespace: state.apollo.appId,
      group: state.apollo.cluster,
      dataId: state.apollo.namespaceName,
      key: "feature.enabled",
    };

    await invoke("ConfigCenterPublishConfigFromApplyPlan", [profile, { ref, content: "false", format: "properties" }]);
    await expect(invoke("ConfigCenterGetConfig", [profile, { ...ref, key: "" }])).resolves.toMatchObject({
      content: "feature.enabled=false\nserver.port=8080\n",
      version: "release-2",
    });
    await invoke("ConfigCenterDeleteConfigFromApplyPlan", [profile, { ...ref, key: "server.port" }]);
    await expect(invoke("ConfigCenterGetConfig", [profile, { ...ref, key: "" }])).resolves.toMatchObject({
      content: "feature.enabled=false\n",
      version: "release-3",
    });

    expect(requests).toEqual(
      expect.arrayContaining([
        { method: "PUT", path: `${namespacePathForApollo()}/items/feature.enabled?createIfNotExists=true` },
        { method: "DELETE", path: `${namespacePathForApollo()}/items/server.port?operator=confscope` },
        { method: "POST", path: `${namespacePathForApollo()}/releases` },
      ])
    );
  });

  it("routes Consul ConfigCenter bridge calls through Consul KV HTTP API", async () => {
    const state = smokeState();
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/catalog/datacenters") {
        return new Response(JSON.stringify(["dc1"]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname === "/v1/kv/apps/order/" && url.searchParams.get("dc") === "dc1" && url.searchParams.get("recurse") === "true") {
        return new Response(
          JSON.stringify([
            { Key: "apps/order/app.yaml", Value: Buffer.from("feature: true\nserver:\n  port: 8080\n").toString("base64"), ModifyIndex: 42 },
            { Key: "apps/order/feature.json", Value: Buffer.from('{"enabled":true}\n').toString("base64"), ModifyIndex: 43 },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.pathname === "/v1/kv/apps/order/app.yaml" && url.searchParams.get("dc") === "dc1") {
        return new Response(
          JSON.stringify([
            { Key: "apps/order/app.yaml", Value: Buffer.from("feature: true\nserver:\n  port: 8080\n").toString("base64"), ModifyIndex: 42 },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const invoke = createSmokeAppBinding(state);
    const profile = {
      id: "smoke-consul",
      name: "Consul KV",
      provider: "consul",
      baseUrl: state.consul.baseUrl,
      accessToken: "",
      consulDatacenter: state.consul.datacenter,
      consulKeyPrefix: state.consul.keyPrefix,
    };

    await expect(invoke("ConfigCenterTestConnection", [profile])).resolves.toBeUndefined();
    await expect(invoke("ConfigCenterListNamespaces", [profile])).resolves.toEqual([{ id: "dc1", name: "dc1", configCount: 0, kind: 0 }]);
    await expect(
      invoke("ConfigCenterListConfigs", [profile, { namespace: "dc1", group: "apps/order/", dataId: "", pageNo: 1, pageSize: 20 }])
    ).resolves.toMatchObject({
      totalCount: 2,
      pageItems: expect.arrayContaining([
        expect.objectContaining({
          content: "feature: true\nserver:\n  port: 8080\n",
          format: "yaml",
          ref: expect.objectContaining({ provider: "consul", namespace: "dc1", group: "apps/order/", dataId: "apps/order/app.yaml" }),
        }),
      ]),
    });
    await expect(
      invoke("ConfigCenterGetConfig", [
        profile,
        { provider: "consul", connectionId: "smoke-consul", namespace: "dc1", group: "apps/order/", dataId: "apps/order/app.yaml" },
      ])
    ).resolves.toMatchObject({
      content: "feature: true\nserver:\n  port: 8080\n",
      format: "yaml",
      version: "42",
      source: "consul:dc1/apps/order/app.yaml",
    });
  });

  it("routes Consul ApplyPlan bridge writes through KV CAS and preserves conflict failures", async () => {
    const state = smokeState();
    let value: string | null = "feature: true\nserver:\n  port: 8080\n";
    let modifyIndex = 42;
    const requests: Array<{ method: string; path: string; cas: string | null; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = init?.body === undefined ? "" : await new Response(init.body).text();
        requests.push({ method, path: url.pathname, cas: url.searchParams.get("cas"), body });
        if (url.pathname !== "/v1/kv/apps/order/app.yaml" || url.searchParams.get("dc") !== "dc1") {
          return new Response("not found", { status: 404 });
        }
        if (method === "GET") {
          if (value === null) return new Response("not found", { status: 404 });
          return new Response(
            JSON.stringify([{ Key: "apps/order/app.yaml", Value: Buffer.from(value).toString("base64"), ModifyIndex: modifyIndex }]),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (method === "PUT") {
          if (url.searchParams.get("cas") !== String(modifyIndex)) return new Response("false", { status: 200 });
          value = body;
          modifyIndex += 1;
          return new Response("true", { status: 200 });
        }
        if (method === "DELETE") {
          if (url.searchParams.get("cas") !== String(modifyIndex)) return new Response("false", { status: 200 });
          value = null;
          modifyIndex += 1;
          return new Response("true", { status: 200 });
        }
        return new Response("bad method", { status: 405 });
      })
    );
    const invoke = createSmokeAppBinding(state);
    const profile = {
      id: "smoke-consul",
      name: "Consul KV",
      provider: "consul",
      baseUrl: state.consul.baseUrl,
      accessToken: "",
      consulDatacenter: state.consul.datacenter,
      consulKeyPrefix: state.consul.keyPrefix,
    };
    const ref = {
      provider: "consul",
      connectionId: "smoke-consul",
      namespace: "dc1",
      group: "apps/order/",
      dataId: "apps/order/app.yaml",
      key: "__document",
      expectedVersion: "42",
    };

    await invoke("ConfigCenterPublishConfigFromApplyPlan", [profile, { ref, content: "feature: false\nserver:\n  port: 9090\n", format: "yaml" }]);
    await expect(invoke("ConfigCenterGetConfig", [profile, ref])).resolves.toMatchObject({
      content: "feature: false\nserver:\n  port: 9090\n",
      version: "43",
    });
    await expect(
      invoke("ConfigCenterPublishConfigFromApplyPlan", [
        profile,
        { ref: { ...ref, expectedVersion: "42" }, content: "stale: true\n", format: "yaml" },
      ])
    ).rejects.toThrow("CAS");
    await invoke("ConfigCenterDeleteConfigFromApplyPlan", [profile, { ...ref, expectedVersion: "43" }]);
    await expect(invoke("ConfigCenterGetConfig", [profile, ref])).rejects.toThrow("Consul KV get failed 404");

    expect(requests).toEqual(
      expect.arrayContaining([
        { method: "PUT", path: "/v1/kv/apps/order/app.yaml", cas: "42", body: "feature: false\nserver:\n  port: 9090\n" },
        { method: "PUT", path: "/v1/kv/apps/order/app.yaml", cas: "42", body: "stale: true\n" },
        { method: "DELETE", path: "/v1/kv/apps/order/app.yaml", cas: "43", body: "" },
      ])
    );
  });
});

function namespacePathForApollo(): string {
  return "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application";
}

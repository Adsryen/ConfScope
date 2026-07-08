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
});

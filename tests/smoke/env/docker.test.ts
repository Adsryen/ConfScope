/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { apolloContainerOptions, consulContainerOptions, webDAVContainerOptions } from "./docker";
import type { SmokeApolloEndpoint, SmokeConsulEndpoint, SmokeWebDAVEndpoint } from "./workspace";

describe("webDAVContainerOptions", () => {
  it("builds a loopback generic WebDAV container with mounted smoke storage and basic auth", () => {
    const endpoint: SmokeWebDAVEndpoint = {
      containerName: "confscope-smoke-webdav",
      hostPort: 18861,
      baseUrl: "http://127.0.0.1:18861",
      username: "smoke",
      password: "smoke-pass",
      rootPath: "/confscope",
    };

    const options = webDAVContainerOptions(endpoint, "C:/repo/ConfScope/.tmp/full-smoke-1/webdav");

    expect(options.name).toBe("confscope-smoke-webdav");
    expect(options.image).toBe("bytemark/webdav");
    expect(options.args).toEqual(
      expect.arrayContaining([
        "--network",
        "confscope-smoke",
        "-p",
        "127.0.0.1:18861:80",
        "-v",
        "C:/repo/ConfScope/.tmp/full-smoke-1/webdav:/var/lib/dav",
        "-e",
        "AUTH_TYPE=Basic",
        "-e",
        "USERNAME=smoke",
        "-e",
        "PASSWORD=smoke-pass",
        "-e",
        "LOCATION=/",
      ])
    );
    expect(options.args).not.toContain("node");
  });
});

describe("apolloContainerOptions", () => {
  it("builds a loopback Apollo-compatible OpenAPI fixture container", () => {
    const endpoint: SmokeApolloEndpoint = {
      containerName: "confscope-smoke-apollo",
      hostPort: 18862,
      baseUrl: "http://127.0.0.1:18862",
      token: "apollo-smoke-token",
      env: "DEV",
      appId: "order-service",
      cluster: "default",
      namespaceName: "application",
    };

    const options = apolloContainerOptions(endpoint, "C:/repo/ConfScope/tests/smoke/fixtures/apollo/server.mjs");

    expect(options.name).toBe("confscope-smoke-apollo");
    expect(options.image).toBe("node:20-alpine");
    expect(options.args).toEqual(
      expect.arrayContaining([
        "--network",
        "confscope-smoke",
        "-p",
        "127.0.0.1:18862:8070",
        "-v",
        "C:/repo/ConfScope/tests/smoke/fixtures/apollo/server.mjs:/srv/apollo-server.mjs:ro",
        "-e",
        "APOLLO_SMOKE_TOKEN=apollo-smoke-token",
        "-e",
        "APOLLO_SMOKE_ENV=DEV",
        "-e",
        "APOLLO_SMOKE_APP_ID=order-service",
        "-e",
        "APOLLO_SMOKE_CLUSTER=default",
        "-e",
        "APOLLO_SMOKE_NAMESPACE=application",
      ])
    );
    expect(options.command).toEqual(["node", "/srv/apollo-server.mjs"]);
  });
});

describe("consulContainerOptions", () => {
  it("builds a loopback Consul dev agent container with the smoke datacenter", () => {
    const endpoint: SmokeConsulEndpoint = {
      containerName: "confscope-smoke-consul",
      hostPort: 18863,
      baseUrl: "http://127.0.0.1:18863",
      datacenter: "dc1",
      keyPrefix: "apps/order/",
    };

    const options = consulContainerOptions(endpoint);

    expect(options.name).toBe("confscope-smoke-consul");
    expect(options.image).toBe("hashicorp/consul:1.20.0");
    expect(options.args).toEqual(
      expect.arrayContaining(["--network", "confscope-smoke", "-p", "127.0.0.1:18863:8500"])
    );
    expect(options.command).toEqual(["agent", "-dev", "-client=0.0.0.0", "-datacenter=dc1"]);
  });
});

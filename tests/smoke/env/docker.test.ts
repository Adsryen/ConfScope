/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { webDAVContainerOptions } from "./docker";
import type { SmokeWebDAVEndpoint } from "./workspace";

describe("webDAVContainerOptions", () => {
  it("builds a loopback WebDAV container with mounted smoke storage and basic auth", () => {
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
    expect(options.image).toBe("node:22-alpine");
    expect(options.args).toEqual(
      expect.arrayContaining([
        "--network",
        "confscope-smoke",
        "-p",
        "127.0.0.1:18861:8080",
        "-v",
        "C:/repo/ConfScope/.tmp/full-smoke-1/webdav:/data",
        "-e",
        "AUTH_USER=smoke",
        "-e",
        "AUTH_PASS=smoke-pass",
      ])
    );
  });
});

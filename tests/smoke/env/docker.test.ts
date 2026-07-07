/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { webDAVContainerOptions } from "./docker";
import type { SmokeWebDAVEndpoint } from "./workspace";

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

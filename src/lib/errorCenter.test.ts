/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearErrors, reportError } from "./errorCenter";
import { toast } from "./toast";

vi.mock("./toast", () => ({
  toast: vi.fn(),
}));

describe("errorCenter", () => {
  beforeEach(() => {
    localStorage.clear();
    clearErrors();
    vi.mocked(toast).mockReset();
  });

  it("localizes the default toast summary", () => {
    localStorage.setItem("locale", "en-US");

    reportError({ title: "Load failed", message: "Network error" });

    expect(toast).toHaveBeenCalledWith("Load failed, saved to Message Center", "error");
  });

  it("localizes the repeated-message toast summary", () => {
    localStorage.setItem("locale", "en-US");

    reportError({ title: "Load failed", message: "first", mergeKey: "load" });
    reportError({ title: "Load failed", message: "second", mergeKey: "load" });

    expect(toast).toHaveBeenLastCalledWith("Load failed (2 times, saved to Message Center)", "error");
  });

  it("keeps explicit toast text unchanged", () => {
    localStorage.setItem("locale", "en-US");

    reportError({ title: "Load failed", message: "Network error", toast: "Custom summary" });

    expect(toast).toHaveBeenCalledWith("Custom summary", "error");
  });
});

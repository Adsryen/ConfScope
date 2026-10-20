/**
 * 版本号可比性判据（轮51）：钉住「dev 不许被当成 0.0.0 去比」。
 */
import { describe, expect, it } from "vitest";
import { isComparableReleaseVersion, releaseVersionCore } from "./appVersion";

describe("releaseVersionCore", () => {
  it("正常版本号都能取出三段核心", () => {
    expect(releaseVersionCore("1.9.2")).toBe("1.9.2");
    expect(releaseVersionCore("v1.9.2")).toBe("1.9.2");
    expect(releaseVersionCore("1.9.2-beta.1")).toBe("1.9.2");
    expect(releaseVersionCore("1.9.2+build.7")).toBe("1.9.2");
    // 本地 git describe 形态：关于页与后台检查都要能认它
    expect(releaseVersionCore("v1.9.1-136-g84fd158-dirty")).toBe("1.9.1");
    expect(releaseVersionCore("refs/tags/v1.9.2")).toBe("1.9.2");
  });

  it("不可比的形态一律拿不到核心版本", () => {
    // 本轮线上事故的形态：Go 侧解析成 0.0.0，所以调用侧必须自己挡住
    expect(releaseVersionCore("dev")).toBeNull();
    expect(releaseVersionCore("")).toBeNull();
    expect(releaseVersionCore("   ")).toBeNull();
    // 无 tag 时 git describe --always 退化成 sha
    expect(releaseVersionCore("84fd158-dirty")).toBeNull();
    // 凑不满三段
    expect(releaseVersionCore("1.9")).toBeNull();
    expect(releaseVersionCore("nightly")).toBeNull();
  });

  it("isComparableReleaseVersion 与核心抽取同向", () => {
    expect(isComparableReleaseVersion("1.9.2")).toBe(true);
    expect(isComparableReleaseVersion("v1.9.1-136-g84fd158-dirty")).toBe(true);
    expect(isComparableReleaseVersion("dev")).toBe(false);
    expect(isComparableReleaseVersion("84fd158-dirty")).toBe(false);
    expect(isComparableReleaseVersion(undefined as unknown as string)).toBe(false);
  });
});

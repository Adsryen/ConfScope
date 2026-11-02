import { describe, expect, it } from "vitest";
import { isSameSnapshotPath, normalizeSnapshotPathForCompare } from "./localSnapshotPath";

describe("normalizeSnapshotPathForCompare", () => {
  it("把 Windows 目录收成同一种写法", () => {
    expect(normalizeSnapshotPathForCompare("C:\\backup\\order\\")).toBe("c:/backup/order");
    expect(normalizeSnapshotPathForCompare("C:/backup/order")).toBe("c:/backup/order");
    expect(normalizeSnapshotPathForCompare("  C:\\backup\\order  ")).toBe("c:/backup/order");
    expect(normalizeSnapshotPathForCompare("c:\\backup\\order")).toBe("c:/backup/order");
  });

  it("盘符根与 UNC 根不被抹成空串", () => {
    expect(normalizeSnapshotPathForCompare("C:\\")).toBe("c:/");
    expect(normalizeSnapshotPathForCompare("\\\\fs\\share\\")).toBe("//fs/share");
    expect(normalizeSnapshotPathForCompare("/")).toBe("/");
  });

  it("POSIX 路径只清尾部斜杠，大小写保持敏感", () => {
    expect(normalizeSnapshotPathForCompare("/data/snapshot/")).toBe("/data/snapshot");
    expect(normalizeSnapshotPathForCompare("/Data/snapshot")).toBe("/Data/snapshot");
    expect(normalizeSnapshotPathForCompare("")).toBe("");
    expect(normalizeSnapshotPathForCompare(undefined)).toBe("");
  });
});

describe("isSameSnapshotPath", () => {
  it("校验回来的规范路径与用户手打写法算同一条", () => {
    expect(isSameSnapshotPath("C:\\backup\\order-new", "c:/backup/order-new/")).toBe(true);
    expect(isSameSnapshotPath("\\\\fs\\share\\snap", "\\\\fs\\share\\snap\\")).toBe(true);
    expect(isSameSnapshotPath("/data/snap", "/data/snap/")).toBe(true);
  });

  it("不同目录、大小写敏感的 POSIX 路径、空值都不算相等", () => {
    expect(isSameSnapshotPath("C:\\backup\\a", "C:\\backup\\b")).toBe(false);
    expect(isSameSnapshotPath("/Data/snap", "/data/snap")).toBe(false);
    expect(isSameSnapshotPath("", "C:\\backup\\a")).toBe(false);
    expect(isSameSnapshotPath(undefined, undefined)).toBe(true);
  });
});

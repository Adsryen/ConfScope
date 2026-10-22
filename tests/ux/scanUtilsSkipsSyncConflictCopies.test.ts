/**
 * 静态扫描的文件口径（轮66 WP-5 顺带补）。
 *
 * 起因是实测到的环境噪声：另一台设备把旧仓库同步进来时，Syncthing 在 src/ 下留了几十份
 * `*.sync-conflict-<日期>-<设备>` 副本。它们仍是以 .tsx 收尾的源码文件名，但不是
 * `.test.tsx`，于是被当成源码扫进守卫，报出「旧英文句式还在源码里」的假红，
 * `tsc --noEmit` 也跟着红（旧副本引用了已被改名的导出）。
 * 这类副本不该进任何扫描口径，但排除判据必须能自证，否则就是拿一条正则把真源码也扫没了。
 */
import { describe, expect, it } from "vitest";
import { isScannedSourceName, sourceFiles } from "./scanUtils";

describe("sourceFiles 的文件口径", () => {
  it("Syncthing 冲突副本不进扫描", () => {
    expect(isScannedSourceName("ApplyPlanView.test.sync-conflict-20261023-011415-5E6GXY3.tsx")).toBe(false);
    expect(isScannedSourceName("App.sync-conflict-20261022-172036-5E6GXY3.tsx")).toBe(false);
    expect(isScannedSourceName("nacos.sync-conflict-20261022-171613-5E6GXY3.ts")).toBe(false);
  });

  it("正常源码与用例照常判定：不许把真文件一起排除掉", () => {
    expect(isScannedSourceName("DiffView.tsx")).toBe(true);
    expect(isScannedSourceName("applyPlan.ts")).toBe(true);
    expect(isScannedSourceName("DiffView.test.tsx")).toBe(false);
    expect(isScannedSourceName("99-s-target-size.spec.ts")).toBe(false);
    expect(isScannedSourceName("styles.css")).toBe(false);
  });

  it("扫描清单不是空转：真源码还在里面，且一份冲突副本都没有", () => {
    const files = sourceFiles();
    expect(files.length, "一条源码都没扫到，说明排除判据扫过头了").toBeGreaterThan(60);
    expect(files).toContain("src/components/DiffView.tsx");
    expect(files.filter((file) => file.includes(".sync-conflict-"))).toEqual([]);
  });
});

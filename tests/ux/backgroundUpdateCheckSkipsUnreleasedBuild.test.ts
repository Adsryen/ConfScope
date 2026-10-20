/**
 * 后台自动更新检查必须先确认版本号可比（轮51）。
 *
 * 机理：Go 的 appVersion 靠 -ldflags -X 注入，注入路径写错时链接器静默忽略
 * （v1.9.1 就是这么发的），产物带着默认 "dev" 上线；parseVersion("dev") 等价 0.0.0，
 * CompareVersions(最新版, "dev") > 0 恒真 ⇒ 启动 5 分钟后的后台检查永远弹
 * 「有新版本 v1.9.1 可用」，哪怕用户装的正是 1.9.1，只能靠关于页「忽略此版本」压住。
 *
 * 守卫钉三条：
 * 1. App.tsx 的后台检查里，isComparableReleaseVersion 必须夹在 getAppInfo() 与
 *    checkForUpdates({ 之间——顺序错了等于没挡；
 * 2. 判据只许有一份实现（src/lib/appVersion.ts），App.tsx 必须 import 它，
 *    不许就地比 "dev" 字面量（下次改语义又会分叉）；
 * 3. 关于页的手动检查不许被这个判据挡掉：开发版用户点了「检查更新」就该看到真实最新版，
 *    误加判据会让按钮变成假死。
 */
import { describe, expect, it } from "vitest";
import { readScannedSource } from "./scanUtils";

const APP = "src/App.tsx";
const ABOUT = "src/components/About.tsx";

/** 关于页的手动检查里只要出现判据就视为被挡（本轮要求是「不许挡」）。 */
function manualCheckIsGated(text: string): boolean {
  const call = text.indexOf("checkForUpdates({");
  if (call < 0) return false;
  const start = text.lastIndexOf("runUpdateCheck", call);
  return text.slice(start < 0 ? 0 : start, call).includes("isComparableReleaseVersion(");
}

function backgroundCheckHasGate(text: string): boolean {
  const call = text.indexOf("checkForUpdates({");
  if (call < 0) return false;
  const timer = text.lastIndexOf("setTimeout(", call);
  if (timer < 0) return false;
  const slice = text.slice(timer, call);
  return slice.includes("await getAppInfo()") && slice.includes("isComparableReleaseVersion(");
}

describe("后台更新检查跳过不可比版本号（轮51）", () => {
  it("App.tsx 的后台检查在发请求前用判据挡住 dev 构建", () => {
    const appText = readScannedSource(APP);
    expect(appText.indexOf("checkForUpdates({"), "App.tsx 里找不到后台检查调用").toBeGreaterThan(-1);
    expect(backgroundCheckHasGate(appText)).toBe(true);
  });

  it("App.tsx 只许 import 唯一出口，不许就地比 dev 字面量", () => {
    const appText = readScannedSource(APP);
    expect(appText).toContain('import { isComparableReleaseVersion } from "./lib/appVersion"');
    expect(appText.includes('=== "dev"') || appText.includes('!== "dev"'), "App.tsx 自己拼了 dev 字面量判据").toBe(false);
  });

  it("关于页手动检查不受影响（点了检查更新就必须真发请求）", () => {
    const aboutText = readScannedSource(ABOUT);
    expect(aboutText).toContain("checkForUpdates({");
    expect(manualCheckIsGated(aboutText), "关于页被误加判据，开发版的检查更新会变成假死").toBe(false);
  });

  it("自检：把判据挪到请求之后必须判红（顺序错了等于没挡）", () => {
    const moved = [
      "useEffect(() => {",
      "  const timer = setTimeout(async () => {",
      "    const info = await getAppInfo();",
      "    const result = await checkForUpdates({ currentVersion: info.version });",
      "    if (!isComparableReleaseVersion(info.version)) return;",
      "  }, 300000);",
      "});",
    ].join("\n");
    expect(backgroundCheckHasGate(moved)).toBe(false);
  });

  it("自检：本轮线上的形态（后台检查根本没有判据）必须判红", () => {
    const withoutGate = [
      "useEffect(() => {",
      "  const timer = setTimeout(async () => {",
      "    const info = await getAppInfo();",
      "    const result = await checkForUpdates({ currentVersion: info.version });",
      "  }, 300000);",
      "});",
    ].join("\n");
    expect(backgroundCheckHasGate(withoutGate)).toBe(false);
  });

  it("自检：关于页被误加判据必须判红", () => {
    const gatedAbout = [
      "const runUpdateCheck = async () => {",
      "  if (!isComparableReleaseVersion(appInfo.version)) return;",
      "  const result = await checkForUpdates({ currentVersion: appInfo.version });",
      "};",
    ].join("\n");
    expect(manualCheckIsGated(gatedAbout)).toBe(true);
  });
});

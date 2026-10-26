/**
 * 反馈通道排版层（轮80）。
 *
 * 这块文本会被用户原样贴进公开 Issue，所以判据只有两类：
 * 1. 形状——维护者要能一眼读完，字段名固定英文、顺序稳定；
 * 2. 边界——只许出现那 5 项事实 + 界面语言，别的一律不许渗进来。
 * 第 2 类是本文件存在的理由：真出事故时，泄露的不是排版而是「谁都能顺手多带一个字段」的口子。
 */
import { describe, expect, it } from "vitest";
import { buildFeedbackEnvironment, buildNewIssueURL, FEEDBACK_REPO_URL, type FeedbackFacts } from "./feedbackDiagnostics";

const facts: FeedbackFacts = {
  version: "1.9.13",
  platform: "windows-amd64",
  runtimeMode: "installed",
  packageFormat: "",
  assetName: "confscope-windows-amd64-installer.exe",
};

describe("buildFeedbackEnvironment", () => {
  it("五项事实 + 界面语言，顺序与字段名钉死（维护者按这个形状读）", () => {
    expect(buildFeedbackEnvironment(facts, "zh-CN")).toBe(
      [
        "- ConfScope version: 1.9.13",
        "- Platform: windows-amd64",
        "- Runtime mode: installed",
        "- Package: confscope-windows-amd64-installer.exe",
        "- UI language: zh-CN",
      ].join("\n")
    );
  });

  it("packageFormat 有值才占一行：Windows/mac 用户不该看到一条空值行去猜是不是坏了", () => {
    expect(buildFeedbackEnvironment(facts, "zh-CN")).not.toContain("Package format");
    expect(buildFeedbackEnvironment({ ...facts, packageFormat: "deb" }, "zh-CN")).toBe(
      buildFeedbackEnvironment(facts, "zh-CN") + "\n- Package format: deb"
    );
  });

  it("界面语言取的是当前 locale，不是 Go 那边的默认值", () => {
    expect(buildFeedbackEnvironment(facts, "en-US")).toContain("- UI language: en-US");
  });

  it("Go 多给的字段绝不带出去：函数只认这 5 个键，多余的键连读都不读", () => {
    // 现实里出事故就是这么出的：谁往 FeedbackDiagnostics 上加了 dataDir，
    // 只要没人改这个函数，它就进不了反馈块。
    const poisoned = {
      ...facts,
      dataDir: "C:\\Users\\adsry\\AppData\\Local\\ConfScope",
      home: "/home/adsry",
      connectionLabel: "生产 MSE",
      namespace: "public-prod",
    } as unknown as FeedbackFacts;
    const out = buildFeedbackEnvironment(poisoned, "zh-CN");
    for (const leak of ["adsry", "AppData", "Users", "生产", "MSE", "public-prod", "namespace", "dataDir", "/home"]) {
      expect(out, `反馈块里出现了不该有的 ${leak}`).not.toContain(leak);
    }
  });
});

describe("buildNewIssueURL", () => {
  const sections = ["## 问题描述", "", "## 复现步骤", "1. "];

  it("环境块在最前，空行分隔，段落模板跟在后面", () => {
    const url = buildNewIssueURL(buildFeedbackEnvironment(facts, "zh-CN"), sections);
    const body = decodeURIComponent(url.split("?body=")[1]);
    expect(body.startsWith("- ConfScope version: 1.9.13")).toBe(true);
    expect(body).toContain("\n\n## 问题描述");
    expect(body).toContain("## 复现步骤");
  });

  it("换行与中文全部 encode：一贴到聊天窗就断的链接等于没预填", () => {
    const url = buildNewIssueURL("a\nb", ["中文段落"]);
    expect(url).toBe(`${FEEDBACK_REPO_URL}/issues/new?body=${encodeURIComponent("a\nb\n\n中文段落")}`);
    expect(url).not.toContain("\n");
    expect(url).not.toContain("中文");
  });

  it("空段落丢掉，但环境块为空也照样给得出链接（读不到事实≠不许反馈）", () => {
    const url = buildNewIssueURL("", ["", "   ", "## 问题描述"]);
    const body = decodeURIComponent(url.split("?body=")[1]);
    expect(body).not.toContain("   ");
    expect(body).toContain("## 问题描述");
    expect(url.startsWith(`${FEEDBACK_REPO_URL}/issues/new?body=`)).toBe(true);
  });

  it("落地处只有自家仓库", () => {
    expect(buildNewIssueURL("x", []).startsWith("https://github.com/Adsryen/ConfScope/issues/new?body=")).toBe(true);
  });
});

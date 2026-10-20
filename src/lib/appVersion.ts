/**
 * 版本号可比性判据（轮51）。
 *
 * 为什么要有这个文件：Go 侧 `appVersion` 只由构建期 `-ldflags -X` 注入，取不到时留默认值 `"dev"`。
 * `internal/updatecheck.parseVersion("dev")` 不会报错——Atoi 失败后 parts 留在零值，等价 `0.0.0`，
 * 于是 `CompareVersions(最新正式版, "dev") > 0` 恒真：v1.9.1 的发布产物（注入路径写错被链接器静默忽略）
 * 就这样让每个用户在启动 5 分钟后收到「有新版本可用」，即使装的正是最新版。
 *
 * 结论：**「版本号不可比」不等于「版本很旧」**，发请求前必须先过这道判据。
 * 口径与 Go 的 parseVersion 对齐（允许 v/V 前缀、预发布与 build 后缀、允许从 refs/tags/xxx 里取候选），
 * 但不接受解析后凑不满三段数字的字符串。
 */

/** 与 internal/updatecheck/checker.go 的 semverCandidate 同形态的候选抓取。 */
const SEMVER_CANDIDATE = /[vV]?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/;

/** 从任意形态里抽出核心版本三段；抽不出三段数字返回 null。 */
export function releaseVersionCore(version: string): string | null {
  const raw = (version ?? "").trim();
  if (!raw) return null;
  const candidate = SEMVER_CANDIDATE.exec(raw)?.[0] ?? "";
  if (!candidate) return null;
  const core = candidate.replace(/^[vV]/, "").split("+")[0].split("-")[0];
  const parts = core.split(".");
  if (parts.length !== 3) return null;
  return parts.every((part) => /^\d+$/.test(part)) ? parts.join(".") : null;
}

/** 能不能拿它跟发布版本比大小——后台自动更新检查的唯一准入条件。 */
export function isComparableReleaseVersion(version: string): boolean {
  return releaseVersionCore(version) !== null;
}

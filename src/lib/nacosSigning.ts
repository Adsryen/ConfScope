/**
 * 「这个连接的请求要不要带阿里云 MSE（Spas）签名」的唯一判据（轮65）。
 *
 * 与 Go 侧 `internal/provider/nacos.go` 的 `nacosRequestSignRequested` 同一条规则，
 * 两边必须一起改：前端按它决定「要不要把空 group 补成 DEFAULT_GROUP」「要不要跳过
 * Nacos 用户名登录」，Go 按它决定「挂不挂签名头」「签名 resource 用什么」。
 * 一旦两处判据错开，就会出现「前端请求 A 组、后端按 B 组签名」这种没人看得懂的 403。
 *
 * 命中任意一条即视为需要签名：
 * 1. 连接声明「阿里云 MSE + AK/SK」。凭据没填也要走签名通路，由 Go 在发请求前
 *    报 ErrMSEAuthMissing（轮60），不允许静默退化成匿名请求。
 * 2. AccessKey/SecretKey 都填齐了。服务端要不要签名取决于请求里有没有 AccessKey，
 *    不取决于用户把「发行版」「认证方式」两个下拉配成了一对——2026-10-22 真机
 *    第 5 步 403 `accessKeyId can't be null` 就是这个形态。
 */

/** 只取判据需要的字段：`Connection` 与 `ConnectionProfile` 都满足这个形状。 */
export type NacosSigningSubject = {
  distribution?: string;
  authType?: string;
  accessKeyId?: string;
  accessKeySecret?: string;
};

function hasCredential(value?: string): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** 请求要不要带阿里云 MSE（Spas）签名头——与 Go 的 `nacosRequestSignRequested` 一一对应。 */
export function nacosRequestSignRequested(subject: NacosSigningSubject): boolean {
  if (subject.distribution === "aliyun-mse" && subject.authType === "aliyun-aksk") {
    return true;
  }
  return hasCredential(subject.accessKeyId) && hasCredential(subject.accessKeySecret);
}

/**
 * 这个连接是不是靠 AccessKey 认证（因此不要走 Nacos 用户名/密码登录，也不要去探测 v3 接口）。
 *
 * 比签名判据更宽：认证方式选了 AK/SK 就算，凭据还没填也归它——那种情况该由后端报
 * 「缺少 AccessKey」，而不是前端拿着空用户名去登录，换回一句「账号或密码错误」。
 */
export function nacosAuthUsesAccessKey(subject: NacosSigningSubject): boolean {
  return subject.authType === "aliyun-aksk" || nacosRequestSignRequested(subject);
}

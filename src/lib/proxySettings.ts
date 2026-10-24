/**
 * 代理设置的输入判据（轮72 R-B2）。
 *
 * 为什么要有这个文件：设置页的三个代理框原先每次按键都把草稿写进 `cs.settings`——
 * 不 trim、不校验。真机实测打进 `   not-a-url   ` 就直接落库，界面上还是一片正常。
 * 而 Go 侧 `internal/updatecheck/checker.go` 的 `proxyFunc` 只做一次 `url.Parse`：
 * `not-a-url` 解析得出（当成相对 URL）、`socks5://…` 解析得出但 Go 根本没接 socks 代理，
 * 结果是**检查更新静默走不上代理**。界面判得比 Go 松，用户就得到一个只会说谎的设置页。
 *
 * 口径与 Go 的实际能力一致：
 * - 代理地址只接受 `http://` / `https://` 且必须有主机名；协议名统一小写（Go 用
 *   `proxyURL.Scheme == "https"` 决定要不要 CONNECT，`HTTP://` 会被当成明文转发）。
 * - 不走代理的表项按 `noProxyMatch` 的判据收：精确主机名、`.example.com` 这类后缀、
 *   CIDR、`*`。`*.example.com` 在 Go 里永远匹配不上（它只认 `.` 开头或裸域名），
 *   所以提交时归一成 `.example.com`——同一个意思，换个 Go 认得的写法。
 * - 空串 = 不使用代理（清空就是关掉），不报错。
 *
 * 校验只在「提交那一刻」（失焦 / Enter）跑：不在加载时清洗历史数据，
 * 免得把用户以前存进去的值悄悄删掉，让他以为是自己弄丢的。
 */
import type { ProxySettings } from "../store/settings";

export type ProxyField = keyof ProxySettings;

/** 失败原因的稳定字面量：界面按它取文案，别把句子拼在 lib 里。 */
export type ProxyIssue = "url" | "noProxyItem";

/**
 * 判别联合：`valid === false` 那一支必然带着 `issue`，界面 `if (!outcome.valid)` 之后
 * 不需要再判空、也不需要断言。把「失败一定有原因」写进类型，是为了让设置页没法
 * 悄悄吞掉原因（那正是本轮 R-B1 在清理缓存那儿修掉的毛病）。
 */
export type ProxyFieldOutcome =
  | { valid: true; value: string; issue: "" }
  | { valid: false; value: string; issue: ProxyIssue; detail?: string };

/** 三个框的固定顺序：界面按它渲染，守卫按它数站点。 */
export const PROXY_FIELDS: ProxyField[] = ["httpProxy", "httpsProxy", "noProxy"];

/** 逗号分隔的「不走代理」列表：逐项 trim、丢掉空项、`*.x` 归一成 `.x`。 */
export function normalizeNoProxyList(raw: string): string {
  return noProxyItems(raw).map(normalizeNoProxyItem).join(",");
}

function noProxyItems(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function normalizeNoProxyItem(item: string): string {
  return /^\*\./.test(item) ? `.${item.slice(2)}` : item;
}

/** 表项必须是主机名 / `.后缀` / CIDR / `*`：带协议前缀或空格的一律拒绝（Go 认不得，静默不匹配）。 */
function isNoProxyItemValid(item: string): boolean {
  if (/\s/.test(item)) return false;
  if (item.includes("://")) return false;
  if (item.includes("/")) return isCidr(item);
  return true;
}

/** CIDR 粗判：`前缀/位数`，位数 1..128（Go 侧 net.ParseCIDR 还会再判一次，这里只拦明显写错的）。 */
function isCidr(item: string): boolean {
  const [head, prefix] = item.split("/");
  if (!head || prefix === undefined || item.split("/").length !== 2) return false;
  // 位数必须是纯数字：`10.0.0.0/` 这种半截写法 Number("") 会得到 0，看着像合法其实 Go 解析不了
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  return bits <= 128 && /^[0-9a-fA-F:.]+$/.test(head);
}

/**
 * 代理地址一框的判据：trim → 空值放行 → 必须能被解析成 http(s) 的绝对地址且有主机名。
 * 判不动的（`not-a-url`、`127.0.0.1:7890` 这种缺协议的）一律拒绝——它们正是「静默走不上代理」那一类。
 */
export function readProxyUrlField(raw: string): ProxyFieldOutcome {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: "", valid: true, issue: "" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { value: trimmed, valid: false, issue: "url" };
  }
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();
  if ((scheme !== "http" && scheme !== "https") || parsed.hostname === "") {
    return { value: trimmed, valid: false, issue: "url" };
  }
  // 只把协议名归一小写，端口/路径/凭据一律照用户写的留着（href 会补尾斜杠、吃掉默认端口）
  return { value: trimmed.replace(/^[A-Za-z]+:\/\//, (head) => head.toLowerCase()), valid: true, issue: "" };
}

/** 「不走代理」一框的判据：逐项校验，任一项非法就整框不落库，并点名那一项。 */
export function readNoProxyField(raw: string): ProxyFieldOutcome {
  const items = noProxyItems(raw);
  const invalid = items.find((item) => !isNoProxyItemValid(item));
  if (invalid) return { value: raw.trim(), valid: false, issue: "noProxyItem", detail: invalid };
  return { value: normalizeNoProxyList(raw), valid: true, issue: "" };
}

/** 按字段分派：界面只认这一个入口，免得哪一框漏了校验。 */
export function readProxyField(field: ProxyField, raw: string): ProxyFieldOutcome {
  return field === "noProxy" ? readNoProxyField(raw) : readProxyUrlField(raw);
}

/** 两份代理设置是否逐字段相同：设置页的草稿「跟着已提交值走」时靠它判断要不要覆盖用户正在写的东西。 */
export function isSameProxy(a: ProxySettings, b: ProxySettings): boolean {
  return PROXY_FIELDS.every((field) => a[field] === b[field]);
}

/**
 * 本地快照目录的等价判断（r145 B3）。
 *
 * 为什么要有这一层：保存本地快照连接时，闸口要确认「这次校验的就是用户现在填的这条目录」。
 * 校验结果里的 `path` 是 Go 侧回来的形态，用户手打/粘贴的是另一套形态
 * （结尾多一个 `\`、混用 `/`、盘符大小写不一致都很常见）。拿字符串严格相等比，
 * 就会出现「页面明明显示目录有效，保存仍判你先去校验」的死循环（轮145 实测 C 组）。
 *
 * 口径只在前端比较层生效：不改 Go 的返回值，也不把用户输入回写成规范化值——
 * 回写会让草稿指纹变化，连带把刚发出的校验播报藏进另一道闸（轮142 C 的可见性设计），
 * 修一个坑挖一个更深的坑。
 */

/** Windows 风格路径：盘符开头，或 UNC 的 `\\server\share`。 */
function isWindowsStylePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

/**
 * 用于比较的规范化：去首尾空白、Windows 分隔符统一、去掉末尾多余分隔符。
 * Windows 路径整条小写（大小写不敏感），其他系统保持原样（大小写敏感）。
 * 根目录（`/`、`C:\`）不会被抹成空串。
 */
export function normalizeSnapshotPathForCompare(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) return "";
  if (!isWindowsStylePath(value)) {
    // POSIX：`\` 是合法文件名字符，不动它；只清尾部斜杠，根目录留一个 `/`。
    return value.replace(/\/+$/, "") || "/";
  }
  const unified = value.replace(/\\/g, "/");
  const unc = unified.startsWith("//");
  const body = (unc ? unified.slice(2) : unified).replace(/\/+$/, "");
  // 根目录不能被抹平：`C:\` 收成 `C:/`，`\\fs\\share` 收成 `//fs/share`。
  if (!body) return unc ? "//" : `${unified.slice(0, 2).toLowerCase()}/`;
  if (/^[a-zA-Z]:$/.test(body)) return `${body.toLowerCase()}/`;
  return `${unc ? "//" : ""}${body}`.toLowerCase();
}

/** 两条目录写法是否指同一处。任一侧为空 ⇒ 只有两侧都为空才算相等。 */
export function isSameSnapshotPath(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeSnapshotPathForCompare(a);
  const right = normalizeSnapshotPathForCompare(b);
  if (!left || !right) return left === right;
  return left === right;
}

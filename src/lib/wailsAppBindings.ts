// Wails 原生绑定的唯一取用出口（轮50）。
//
// 为什么要有这个文件：绑定命名空间由 Go 包名决定，不是前端可以各写各的常量。
// 77fa451「拆分 Go 主包，App 迁入 internal/app」把运行时命名空间从 window.go.main.App
// 改成 window.go.app.App，`src/api/*` 走 wailsjs 生成物（编译期跟着变）所以自动跟上，
// 而 `src/lib/appDataDoc.ts` 里手写的那句 `g.go?.main?.App` 没人管——于是主数据文件层
// （水合 / debounce 落盘 / 损坏回退提示）在桌面运行时整体静默失效 45 天。
//
// 约定（守卫 tests/ux/wailsBindingNamespaceIsSingleSource.test.ts 钉死）：
//   - `src/**` 只允许本文件出现 `go` 全局命名空间探测；其它地方要拿绑定一律走 wailsAppBindings()。
//   - 命名空间只有一个字面量 WAILS_APP_NAMESPACE，改包名时改这一处。
//   - 拿不到绑定（纯浏览器 / web 模式 / Wails 未注入）返回 null，由调用方自行降级，
//     绝不抛错——数据层的降级路径必须是显式的，不能靠 undefined 冒泡。

/** Wails 运行时注册 App 服务用的命名空间（等于 Go 侧 internal/app 的包名）。 */
export const WAILS_APP_NAMESPACE = "app";

type WailsGlobal = { go?: Record<string, { App?: unknown }> };

/** 取 `window.go.<namespace>.App` 上的原生服务对象；不存在时返回 null。 */
export function wailsAppBindings<T extends object>(): T | null {
  const g = globalThis as WailsGlobal;
  const app = g.go?.[WAILS_APP_NAMESPACE]?.App as T | undefined;
  return app ?? null;
}

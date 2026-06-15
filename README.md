# 配置中心 · Configuration Center Browser

维护、管理配置中心的桌面工具。MVP 聚焦 **Nacos**：连接服务器、浏览配置、查看历史变更，并提供比 Nacos 原生更智能的 **配置差异对比**。

## 技术栈

对齐「百宝箱」项目：

- **Tauri 2** + **React 18** + **TypeScript** + **Vite 5**
- 后端 **Rust**（`reqwest`）直连 Nacos v1 OpenAPI（1.x / 2.x 兼容）
- 深色 VSCode 风格 UI，纯前端 LCS 行级 diff，零额外重依赖

## 功能（MVP）

| 模块 | 说明 |
| --- | --- |
| 连接管理 | 多套 Nacos（名称 / 地址 / 账号密码 / 默认命名空间），本地持久化，支持连接测试 |
| 认证 | 自动登录拿 `accessToken`、缓存与过期刷新，403 自动重登重试；未开启鉴权的 Nacos 留空账号即可 |
| 配置浏览 | 命名空间切换、按 dataId 模糊搜索、查看配置内容 |
| 历史变更 | 历史版本列表 + 单版本查看 |
| 智能对比 | ① 同一配置两个历史版本对比 ② 历史版本与线上对比 ③ 任意两个配置对比（跨服务器 / 跨命名空间 / 跨 dataId）。并排行级高亮 + 变更统计 + 仅看变更 |

## 开发

```bash
pnpm install
pnpm dev        # 启动 Tauri 桌面应用（开发）
pnpm dev:web    # 仅启动前端（浏览器调试，Tauri 命令不可用）
pnpm build      # 打包 dmg
```

## 目录结构

```
src/
  api/nacos.ts          # invoke 封装 + 类型 + token 缓存/重试
  store/connections.ts  # 连接的本地持久化
  lib/diff.ts           # LCS 行级 diff
  components/           # ConnectionManager / ConfigBrowser / HistoryView / DiffView / DiffPanel
src-tauri/
  src/nacos/mod.rs      # Nacos OpenAPI 客户端 + Tauri 命令
```

## Nacos 接口

| 命令 | Nacos API |
| --- | --- |
| `nacos_login` | `POST /v1/auth/login` |
| `nacos_namespaces` | `GET /v1/console/namespaces` |
| `nacos_list_configs` | `GET /v1/cs/configs?search=blur` |
| `nacos_get_config` | `GET /v1/cs/configs` |
| `nacos_history_list` | `GET /v1/cs/history?search=accurate` |
| `nacos_history_detail` | `GET /v1/cs/history?nid=` |

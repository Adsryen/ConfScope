# ConfScope

> 🎯 **All configs in scope** — 统一配置中心管理工具

浏览、对比、洞察多配置中心（Nacos / Apollo / Consul 等）的配置差异。MVP 聚焦 **Nacos**：连接服务器、浏览配置、查看历史变更，并提供比原生更智能的**配置差异对比**。

## 🙏 致谢与说明

本项目基于 [Configuration-Center-Browser](https://github.com/iGuos/Configuration-Center-Browser) 的优秀设计思路进行二次开发。原项目提供了 Nacos 配置管理的核心理念和前端交互设计，在此向原作者 [iGuos](https://github.com/iGuos) 表示衷心感谢！

**本项目的主要改进：**

- 🔧 **后端完全重构**：从原项目的纯前端方案重构为 **Go + Wails 2** 架构，后端直连 Nacos OpenAPI，提供更稳定的连接和更好的性能
- 🎨 **前端深度优化**：在保留原项目核心功能的基础上，优化了 UI 交互、diff 对比算法、键盘导航等细节体验
- 📦 **桌面应用升级**：从浏览器应用升级为原生桌面应用，支持 Windows/macOS/Linux 多平台
- 🚀 **技术栈现代化**：采用 Wails 2 + Go + React 18 + TypeScript + Vite 5 的现代技术栈

我们尊重原项目的开源精神，本项目将在原项目的基础上持续迭代，未来计划支持更多配置中心（Apollo、Consul 等），欢迎社区贡献。

## ✨ 核心特性

| 模块 | 说明 |
|------|------|
| 🔗 连接管理 | 多套配置中心连接（名称 / 地址 / 账号密码），本地持久化，支持连接测试 |
| 🔐 智能认证 | 自动登录、Token 缓存与过期刷新、403 自动重登重试 |
| 📖 配置浏览 | 命名空间切换、按 dataId 模糊搜索、查看配置内容 |
| 📜 历史变更 | 历史版本列表 + 单版本查看 |
| 🔍 智能对比 | ① 同一配置两个历史版本对比 ② 历史版本与线上对比 ③ 任意两个配置对比（跨服务器 / 跨命名空间 / 跨 dataId）。并排行级高亮 + 变更统计 + 仅看变更 |

## 🛠️ 技术栈

- **Wails 2** + **Go** + **React 18** + **TypeScript** + **Vite 5**
- 后端 **Go** 直连配置中心 OpenAPI（Nacos v1/v3 兼容）
- 深色 VSCode 风格 UI，纯前端 LCS 行级 diff，零额外重依赖

## 🚀 快速开始

### 环境要求

- Node.js >= 18
- pnpm >= 8
- Go >= 1.22
- Wails CLI v2

### 安装

```bash
# 克隆项目
git clone https://github.com/Adsryen/ConfScope.git
cd ConfScope

# 安装前端依赖
pnpm install

# 安装 Wails CLI
go install github.com/wailsapp/wails/v2/cmd/wails@latest

# 检查环境
wails doctor
```

### 开发

```bash
pnpm dev        # 启动 Wails 桌面应用（开发模式）
pnpm dev:web    # 仅启动前端（浏览器调试，Wails Go 绑定不可用）
```

### 构建

```bash
pnpm build      # 打包当前系统桌面应用
pnpm build:win  # Windows 下打包 NSIS exe 安装包
```

## 📁 项目结构

```
ConfScope/
├── src/                          # React 前端
│   ├── api/
│   │   └── nacos.ts              # Wails Go 调用封装 + 类型 + token 缓存/重试
│   ├── store/
│   │   └── connections.ts        # 连接的本地持久化
│   ├── lib/
│   │   ├── diff.ts               # LCS 行级 diff
│   │   └── clipboard.ts          # 剪贴板工具
│   └── components/               # UI 组件
│       ├── ConnectionManager.tsx  # 连接管理
│       ├── ConfigBrowser.tsx      # 配置浏览
│       ├── HistoryView.tsx        # 历史变更
│       ├── DiffView.tsx           # 差异对比
│       └── DiffPanel.tsx          # Diff 面板
├── internal/
│   └── nacos/
│       └── client.go             # Nacos OpenAPI Go 客户端
├── wailsjs/
│   └── go/main/App.ts            # Wails Go 绑定（wails dev/build 自动生成）
├── app.go                        # Wails 应用服务
├── main.go                       # 程序入口
└── wails.json                    # Wails 配置
```

## 🔌 Nacos 接口映射

| 命令 | Nacos API | 说明 |
|------|-----------|------|
| `nacosDetectVersion` | `GET /v1/auth/login` | 探测 Nacos 版本（v1/v3） |
| `nacosLogin` | `POST /v1/auth/login` | 登录获取 accessToken |
| `nacosNamespaces` | `GET /v1/console/namespaces` | 获取命名空间列表 |
| `nacosListConfigs` | `GET /v1/cs/configs?search=blur` | 模糊搜索配置列表 |
| `nacosGetConfig` | `GET /v1/cs/configs` | 获取配置详情 |
| `nacosHistoryList` | `GET /v1/cs/history?search=accurate` | 获取历史版本列表 |
| `nacosHistoryDetail` | `GET /v1/cs/history?nid=` | 获取历史版本详情 |

## 🎨 界面预览

（后续添加截图）

## 📋 路线图

- [x] Nacos v1/v3 双版本支持
- [x] 配置浏览与搜索
- [x] 历史版本查看
- [x] 智能配置对比（行级 diff）
- [ ] Apollo 配置中心适配
- [ ] Consul 配置中心适配
- [ ] 配置导入导出
- [ ] 配置模板管理
- [ ] 批量操作

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

MIT License

---

<p align="center">
  <strong>ConfScope</strong> — <em>Scope your configs</em>
</p>

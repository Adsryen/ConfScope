# Changelog

本项目的所有显著更改都将记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.1.0] - 2026-07-02

### Added
- ✨ **Provider 抽象层**: Go 后端 ConfigProvider 接口 + Nacos/Local 适配器
- ✨ **阿里云 MSE Nacos**: 支持 AK/SK 签名认证
- ✨ **全局代理配置**: SettingsView 网络分组，支持 HTTP/HTTPS/NoProxy
- ✨ **连接表单代理开关**: 按连接选择是否走系统代理
- ✨ **应用检查更新**: 多线路自动回退 + 后台低频静默检查
- ✨ **版本号 ldflags 注入**: 构建时从 git tag 注入版本号
- ✨ **更新 ignore**: 支持"忽略此版本"，mandatory 时禁止忽略
- ✨ **连接管理项目/环境层级**: 项目分组 + 环境标签
- ✨ **本地快照目录来源**: 本地目录作为只读 provider 参与对比
- ✨ **全局消息中心**: 错误聚合、合并、复制、已读管理
- ✨ **SSH 配置档案**: 可复用 SSH 配置，连接引用 + 影响范围提示
- ✨ **智能对比容错**: 单侧故障不阻断，失败侧标记 + 重试
- ✨ **HTTP 网络层重试**: 3 次指数退避，自动恢复瞬时网络抖动
- ✨ **连接池优化**: IdleConnTimeout 30s，MaxIdleConnsPerHost 4
- ✨ **批量对比失败内联展示**: 失败 dataId 列表 + 逐个重试
- ✨ **对比/浏览刷新按钮**: 一键刷新匹配列表和配置内容
- ✨ **连接测试进度提示**: 实时计时 + 超时黄色警告
- ✨ **本地快照对比标签**: 区分本地路径与远程 Nacos 连接
- ✨ **错误复制按钮**: 全错误场景统一提供 CopyButton

### Changed
- 🔄 左侧主导航取代顶部双模式切换
- 🔄 无边框窗口，自绘主布局
- 🔄 连接管理升级为 provider 感知表单
- 🔄 应用版本默认 `dev`，发布时 ldflags 注入
- 🔄 SettingsView 按基础信息/认证/网络/安全/高级分组
- 🔄 所有 Go/TS 注释统一使用中文

### Fixed
- 🐛 连接池复用失效导致 `context deadline exceeded` 误报
- 🐛 对比页 A/B 侧同时加载失败时无重试入口
- 🐛 命名空间加载失败无复制按钮

### Engineering
- ESLint + Prettier + TypeScript strict + noUnusedLocals
- Trellis 任务线管理（12 个归档任务）
- Spec 规范文档（backend 5 + frontend 6）
- Go 57 测试 + 前端 161 测试全绿

## [0.1.0] - 2026-06-24

### Added
- ✨ 从 Tauri 迁移到 **Wails 2** + **Go** 后端
- ✨ Nacos OpenAPI v1/v3 双版本自动探测
- ✨ 连接管理（多套 Nacos 服务器配置）
- ✨ 智能认证（Token 缓存、过期刷新、403 自动重试）
- ✨ 配置浏览（命名空间切换、模糊搜索）
- ✨ 历史版本查看
- ✨ 智能配置对比（LCS 行级 diff）
- ✨ 深色 VSCode 风格 UI
- ✨ 配置内容语法高亮（YAML/JSON/Properties/XML）

### Technical
- Go 后端直连 Nacos OpenAPI，零第三方依赖
- 纯前端 LCS diff 算法，无额外重依赖
- Wails 2 桌面应用框架，支持 Windows/macOS/Linux
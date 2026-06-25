# Changelog

本项目的所有显著更改都将记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed
- 🔄 **项目重命名**: Configuration Center Browser → **ConfScope**
  - 新名称更简洁、国际化
  - 寓意"配置视野"，体现多配置中心统一管理的理念
  - GitHub 仓库: `ConfScope`

## [0.1.0] - 2026-06-24

### Added
- ✨ 从 Tauri 迁移到 **Wails 2** + **Go** 后端
- ✨ Nacos OpenAPI v1/v3 双版本自动探测
- ✨ 连接管理（多套 Nacos 服务器配置）
- ✨ 智能认证（Token 缓存、过期刷新、403 自动重试）
- ✨ 配置浏览（命名空间切换、模糊搜索）
- ✨ 历史版本查看
- ✨ 智能配置对比（LCS 行级 diff）
  - 同一配置的历史版本对比
  - 历史版本与线上版本对比
  - 任意两个配置对比（跨服务器/跨命名空间/跨 dataId）
- ✨ 深色 VSCode 风格 UI
- ✨ 配置内容语法高亮（YAML/JSON/Properties/XML）

### Technical
- Go 后端直连 Nacos OpenAPI，零第三方依赖
- 纯前端 LCS diff 算法，无额外重依赖
- Wails 2 桌面应用框架，支持 Windows/macOS/Linux

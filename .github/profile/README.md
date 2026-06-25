# ConfScope

统一配置中心管理工具

## 简介

ConfScope 是一个桌面端配置中心管理工具，支持浏览、对比、洞察多配置中心（Nacos / Apollo / Consul 等）的配置差异。

## 功能特性

- 🔗 **多配置中心支持** - 目前支持 Nacos，未来将支持 Apollo、Consul 等
- 🔍 **智能配置对比** - 行级差异高亮，支持跨服务器/跨命名空间对比
- 📖 **配置浏览** - 命名空间切换、模糊搜索、配置内容查看
- 📜 **历史变更** - 查看配置的历史版本和变更记录
- 🔐 **智能认证** - 自动 Token 管理和过期刷新

## 技术栈

- **前端**: React 18 + TypeScript + Vite 5
- **后端**: Go + Wails 2
- **UI**: 深色 VSCode 风格

## 快速开始

```bash
# 克隆项目
git clone https://github.com/Adsryen/ConfScope.git
cd ConfScope

# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 构建
pnpm build
```

## 链接

- [GitHub](https://github.com/Adsryen/ConfScope)
- [Issues](https://github.com/Adsryen/ConfScope/issues)
- [Releases](https://github.com/Adsryen/ConfScope/releases)

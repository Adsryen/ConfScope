# 致谢 Credits

## 原项目

本项目 [ConfScope](https://github.com/Adsryen/ConfScope) 基于以下开源项目进行二次开发：

### Configuration-Center-Browser

- **仓库地址**：https://github.com/iGuos/Configuration-Center-Browser
- **原作者**：[iGuos](https://github.com/iGuos)
- **项目简介**：Nacos 配置中心管理工具，提供配置浏览、历史变更查看、智能配置对比等功能

**感谢原作者 iGuos 的优秀设计和开源贡献！**

原项目提供了以下核心设计思路：
- Nacos 配置管理的交互设计
- 配置对比的 UI 布局方案
- 历史版本查看的用户体验设计
- 智能 diff 对比的产品理念

## 二次开发说明

ConfScope 在原项目的基础上进行了以下改进：

### 后端重构（完全重写）
- ✅ 从纯前端方案重构为 **Go + Wails 2** 桌面应用架构
- ✅ 后端 Go 直连 Nacos OpenAPI，提供更稳定的连接
- ✅ 支持 Nacos v1/v3 双版本自动探测
- ✅ 更好的错误处理和重试机制

### 前端优化（深度改进）
- ✅ 优化 diff 对比算法和性能
- ✅ 改进键盘导航和快捷键支持
- ✅ 优化 UI 细节和交互体验
- ✅ 增强配置内容语法高亮

### 桌面应用升级
- ✅ 从浏览器应用升级为原生桌面应用
- ✅ 支持 Windows、macOS、Linux 多平台
- ✅ 更好的系统集成和性能

### 技术栈现代化
- ✅ Wails 2（Go 桌面框架）
- ✅ React 18 + TypeScript
- ✅ Vite 5（构建工具）
- ✅ 现代化的开发体验

## 开源协议

原项目 Configuration-Center-Browser 采用 MIT 协议开源。

本项目 ConfScope 同样采用 [MIT 协议](./LICENSE) 开源，尊重并延续原项目的开源精神。

## 贡献者

感谢所有为 ConfScope 做出贡献的开发者！

---

**如果你觉得 ConfScope 对你有帮助，也请给原项目 [Configuration-Center-Browser](https://github.com/iGuos/Configuration-Center-Browser) 一个 ⭐ Star！**

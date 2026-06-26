# ConfScope 开发待办事项

**最后更新**: 2026-06-25

---

## 🔴 高优先级

### CI/CD 与发布
- [ ] **修复 macOS ARM64 构建** - Wails CLI 在 macOS ARM64 上出现 `dyld: missing LC_UUID load command` 错误
  - **问题**: `wails build` 在 macOS ARM64 (M1/M2) 上崩溃
  - **错误**: `Abort trap: 6`
  - **临时方案**: 已移除 macOS ARM64 构建目标
  - **待查**: 可能需要更新 Wails CLI 版本或调整构建配置
  - **参考**: https://github.com/wailsapp/wails/issues

### 功能完善
- [ ] 添加配置导入导出功能
- [ ] 实现配置模板管理
- [ ] 支持批量操作（批量删除、批量对比）

---

## 🟡 中优先级

### 多配置中心支持
- [ ] **Apollo 配置中心适配**
  - 设计 Apollo 客户端接口
  - 实现 Apollo OpenAPI 集成
  - 支持 Apollo 配置浏览和历史查看
  
- [ ] **Consul 配置中心适配**
  - 设计 Consul KV 客户端接口
  - 实现 Consul HTTP API 集成
  - 支持 Consul 配置浏览

### UI/UX 改进
- [ ] 添加配置内容语法验证（JSON、YAML 格式检查）
- [ ] 实现配置内容搜索（全文搜索）
- [ ] 优化大文件加载性能
- [ ] 添加配置收藏功能
- [ ] 支持配置标签分类

### 性能优化
- [ ] 实现配置内容懒加载
- [ ] 添加本地缓存机制
- [ ] 优化 diff 算法性能（大文件场景）

---

## 🟢 低优先级

### 增强功能
- [ ] 添加配置变更通知（WebSocket 实时推送）
- [ ] 实现配置版本对比可视化（图形化 diff）
- [ ] 支持配置回滚操作
- [ ] 添加配置审计日志
- [ ] 实现配置权限管理

### 平台支持
- [ ] 添加 Linux ARM64 支持
- [ ] 添加 Windows ARM64 支持
- [ ] 添加 macOS ARM64 支持（待修复 Wails CLI 问题）

### 文档与社区
- [ ] 编写详细的用户文档
- [ ] 添加 API 文档
- [ ] 创建贡献指南
- [ ] 添加使用示例和教程

### 开发工具
- [ ] 添加单元测试（Go 后端）
- [ ] 添加单元测试（React 前端）
- [ ] 实现 CI 自动化测试
- [ ] 添加代码覆盖率检查
- [ ] 配置 ESLint 和 Prettier

---

## ✅ 已完成

### 核心功能（v1.0.0）
- [x] Nacos v1/v3 双版本支持
- [x] 配置浏览与搜索
- [x] 历史版本查看
- [x] 智能配置对比（行级 diff）
- [x] 多连接管理
- [x] 自动认证与 Token 管理
- [x] 深色 VSCode 风格 UI

### 技术栈（v1.0.0）
- [x] Wails 2 + Go 后端
- [x] React 18 + TypeScript 前端
- [x] Vite 5 构建
- [x] GitHub Actions CI/CD

### 平台支持（v1.0.0）
- [x] Windows (amd64)
- [x] macOS (amd64)
- [x] Linux (amd64)

### 文档（v1.0.0）
- [x] README.md
- [x] CHANGELOG.md
- [x] LICENSE
- [x] CREDITS.md

---

## 📋 技术债务

### 代码质量
- [ ] 移除未使用的代码
- [ ] 统一代码风格
- [ ] 添加 TypeScript 严格模式检查
- [ ] 优化 import 路径

### 依赖管理
- [ ] 定期更新 Go 依赖
- [ ] 定期更新 npm 依赖
- [ ] 检查安全漏洞

### 构建优化
- [ ] 优化构建产物大小
- [ ] 添加构建缓存
- [ ] 减少构建时间

---

## 🔮 未来展望

### v2.0.0 规划
- [ ] 支持更多配置中心（Etcd、ZooKeeper）
- [ ] 实现配置中心聚合视图（跨配置中心对比）
- [ ] 添加配置中心监控告警
- [ ] 支持配置中心集群管理
- [ ] 实现配置版本控制（Git 集成）

### v3.0.0 规划
- [ ] 添加 Web 版本（浏览器访问）
- [ ] 实现团队协作功能
- [ ] 支持配置中心迁移工具
- [ ] 添加配置中心性能分析

---

## 📝 备注

### macOS ARM64 问题详情
**错误信息**:
```
dyld[1744]: missing LC_UUID load command in /Users/runner/go/bin/wails
dyld[1744]: missing LC_UUID load command
Abort trap: 6
```

**可能原因**:
1. Wails CLI v2.12.0 在 macOS ARM64 上的兼容性问题
2. Go 交叉编译配置问题
3. macOS 签名问题

**解决方案尝试**:
1. ✅ 已尝试：使用 Ubuntu 22.04（解决 Linux webkit2gtk 问题）
2. ✅ 已尝试：更新 Wails 版本到 v2.12.0
3. ⏳ 待尝试：降级 Wails 版本
4. ⏳ 待尝试：使用不同的 Go 版本
5. ⏳ 待尝试：调整 macOS 构建配置

**相关 Issue**:
- https://github.com/wailsapp/wails/issues/3153
- https://github.com/wailsapp/wails/issues/3201

---

**维护者**: Adsryen  
**项目**: https://github.com/Adsryen/ConfScope

### 更新：macOS 支持状态
**2026-06-25**: macOS 支持暂时完全移除
- ❌ macOS ARM64 (darwin-arm64) - Wails CLI dyld 错误
- ❌ macOS AMD64 (darwin-amd64) - 同样的 Wails CLI 错误（exit code 134）
- **原因**: Wails CLI v2.12.0 在 macOS GitHub Actions 运行器上有兼容性问题
- **临时方案**: 仅支持 Linux 和 Windows，macOS 待 Wails 修复后再添加






-----------
- 单个环境需要支持云模式，本地模式，本地就是某一次从云上拉下来的备份，需要支持同环境的多配置位置对比
- 环境需要支持ssh隧道（进行中）
- 全局需要支持代理模式
- 多语言的支持（进行中）
- webdav的备份与恢复，以及本地模式的备份与恢复
- 支持阿里云mse微服务的access key的模式
- 沙箱环境，不能修改后立刻生效，需要严肃的二次确认（特殊环境下，需要人工文字确认，所以需要环境支持标识，例如生产环境需要人工输入文字确认）
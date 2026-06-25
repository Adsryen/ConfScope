# Git 文件跟踪分析报告

**检查时间**: 2026-06-25
**项目**: ConfScope

## 🔍 发现的问题

### ❌ 问题 1: 缓存目录被跟踪
**严重程度**: 🔴 高

**问题描述**: `.cache/` 目录中的文件被跟踪了，这些是 pnpm 的缓存文件，不应该提交到仓库。

**受影响的文件**:
```
.cache/pnpm/metadata-v1.3/registry.npmjs.org/pnpm.json (1.7 MB)
.cache/pnpm/v11/metadata-full/registry.npmjs.org/@pnpm/linux-arm64.jsonl (1.0 MB)
.cache/pnpm/v11/metadata-full/registry.npmjs.org/@pnpm/linux-x64.jsonl (1.2 MB)
.cache/pnpm/v11/metadata-full/registry.npmjs.org/@pnpm/macos-arm64.jsonl (1.1 MB)
.cache/pnpm/v11/metadata-full/registry.npmjs.org/@pnpm/macos-x64.jsonl (1.1 MB)
.cache/pnpm/v11/metadata-full/registry.npmjs.org/@pnpm/win-arm64.jsonl
.cache/pnpm/v11/metadata-full/registry.npmjs.org/@pnpm/win-x64.jsonl (1.2 MB)
.cache/pnpm/v11/metadata/registry.npmjs.org/pnpm.jsonl (1.8 MB)
.cache/pnpm/v11/metadata/registry.npmjs.org/@pnpm/exe.jsonl
```

**影响**:
- 仓库体积增大 ~10 MB
- 包含平台特定文件，其他开发者不需要
- 缓存文件会频繁变化，产生无意义的 diff

**解决方案**: 将 `.cache/` 添加到 `.gitignore`

---

### ⚠️ 问题 2: Wails JS 绑定文件混淆
**严重程度**: 🟡 中

**问题描述**: 存在两套 Wails JS 绑定文件，命名规则不一致。

**当前情况**:
```
# 被忽略的目录
wailsjs/go/              # 在 .gitignore 中

# 但实际被跟踪的文件
wailsjs/go/main/App.ts   # 被跟踪（不应该）
frontend/wailsjs/...     # 被跟踪（可能是旧的）
```

**分析**:
- `wailsjs/` 是 Wails 2 自动生成的绑定目录
- `frontend/wailsjs/` 可能是旧版本残留
- `wailsjs/go/main/App.ts` 被跟踪但应该被忽略

**建议**:
1. 保留 `wailsjs/` 目录（标准 Wails 2 结构）
2. 删除 `frontend/wailsjs/` 目录（旧残留）
3. 更新 `.gitignore` 规则

---

### ✅ 问题 3: go.sum 文件
**严重程度**: 🟢 低（正确行为）

**说明**: `go.sum` 文件被跟踪是**正确的**！

**原因**:
- `go.sum` 记录依赖的加密哈希
- 确保所有开发者使用相同的依赖版本
- Go 官方推荐提交 `go.sum`

**结论**: 保持现状 ✅

---

## 📊 文件跟踪统计

### 当前跟踪的文件
```bash
git ls-files | wc -l
```

### 按类型分类
- **源代码**: Go, TypeScript, CSS
- **配置文件**: JSON, YAML
- **文档**: MD
- **资源**: PNG, ICO
- **生成文件**: go.sum, wailsjs/

---

## 🔧 需要修改的文件

### 1. 更新 `.gitignore`

**需要添加**:
```gitignore
# Cache
.cache/
```

**需要修改**:
```gitignore
# Wails (保留 wailsjs/，但忽略自动生成的绑定)
# wailsjs/go/  # 已存在
frontend/wailsjs/  # 添加这个
```

### 2. 从 Git 中移除缓存文件

```bash
# 移除缓存文件的跟踪（但保留本地文件）
git rm -r --cached .cache/

# 提交更改
git commit -m 'chore: 移除不应跟踪的缓存文件'
```

### 3. 清理旧的 frontend/wailsjs 目录

```bash
# 检查是否还有用
ls -la frontend/wailsjs/

# 如果是旧残留，删除
rm -rf frontend/wailsjs/

# 或添加到 .gitignore
echo "frontend/wailsjs/" >> .gitignore
```

---

## ✅ 应该被跟踪的文件（当前正确）

### 核心源代码
- ✅ `*.go` - Go 后端代码
- ✅ `src/**/*.tsx` - React 前端代码
- ✅ `src/**/*.ts` - TypeScript 代码
- ✅ `src/**/*.css` - 样式文件

### 配置文件
- ✅ `package.json` - npm/pnpm 配置
- ✅ `pnpm-lock.yaml` - 依赖锁定（重要！）
- ✅ `go.mod` - Go 模块配置
- ✅ `go.sum` - Go 依赖哈希（重要！）
- ✅ `wails.json` - Wails 配置
- ✅ `tsconfig.json` - TypeScript 配置
- ✅ `vite.config.ts` - Vite 配置
- ✅ `.gitignore` - Git 忽略规则

### 构建配置
- ✅ `build/` - 构建资源（图标、配置）
- ✅ `Makefile` 或构建脚本

### 文档
- ✅ `README.md`
- ✅ `CHANGELOG.md`
- ✅ `LICENSE`
- ✅ `CREDITS.md`

### 资源文件
- ✅ `build/appicon.png` - 应用图标源文件
- ✅ `build/windows/icon.ico` - Windows 图标
- ✅ `public/` - 静态资源

---

## ❌ 不应该被跟踪的文件（当前有问题）

### 需要立即移除
- ❌ `.cache/` - pnpm 缓存（~10 MB）
- ❌ `frontend/wailsjs/` - 旧的绑定残留

### 已正确忽略
- ✅ `node_modules/` - npm 依赖
- ✅ `dist/` - 构建输出
- ✅ `build/bin/` - 编译的二进制
- ✅ `*.exe`, `*.dll`, `*.so` - 二进制文件
- ✅ `.claude/`, `.agents/` - AI 工具配置
- ✅ `.env*` - 环境变量
- ✅ `*.log` - 日志文件

---

## 🎯 推荐的 .gitignore 更新

```gitignore
# Dependencies
node_modules/
vendor/

# Build output
dist/
build/bin/
*.exe
*.dll
*.so
*.dylib

# Cache
.cache/
.cache/pnpm/

# IDE
.idea/
.vscode/
*.swp
*.swo
*~

# OS
.DS_Store
Thumbs.db

# Go
*.test
*.out
go.work
go.work.sum

# Wails (auto-generated bindings)
wailsjs/go/
frontend/wailsjs/

# Environment
.env
.env.local
.env.*.local

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# Local history
.history/

# Temp files
*.tmp
*.temp

# AI tools
.claude/
.agents/
docs/superpowers/
```

---

## 📋 执行步骤

### 步骤 1: 更新 .gitignore
按照上面的推荐内容更新 `.gitignore` 文件

### 步骤 2: 从 Git 移除缓存
```bash
git rm -r --cached .cache/
```

### 步骤 3: 清理旧目录
```bash
rm -rf frontend/wailsjs/
```

### 步骤 4: 提交更改
```bash
git add .gitignore
git commit -m 'chore: 优化 .gitignore，移除不应跟踪的缓存文件'
```

### 步骤 5: 验证
```bash
# 检查是否还有大文件被跟踪
git ls-files | xargs -I {} sh -c 'size=$(wc -c < "{}"); if [ $size -gt 500000 ]; then echo "{} ($size bytes)"; fi'

# 检查仓库大小
git count-objects -vH
```

---

## 📊 预期效果

### 仓库体积
- **修改前**: ~15-20 MB
- **修改后**: ~5-8 MB
- **减少**: ~50-60%

### 提交历史
- 移除缓存文件后，历史会更干净
- 不会有频繁的缓存文件变更

### 克隆速度
- 更快的克隆速度
- 更少的带宽消耗

---

**生成工具**: Claude Code
**项目**: ConfScope

# 公共配置 - 生产 (QA 预演)
# 本文件各服务共享
# 2026-08: 安全团队要求统一升级注释里说明的版本

common:
  # 时区 (与开发一致)
  timezone: Asia/Shanghai
  # 语言 (与开发一致)
  locale: zh-CN
  # 生产环境标识
  env: prod

# 公共依赖版本
deps:
  # 生产已升级 netty (修复 CVE-2026-1234)
  netty: 4.1.100
  # grpc 生产同步升级
  grpc: 1.58.0

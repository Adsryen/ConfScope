# 公共环境变量 - 生产 (QA 预演)
# 本文件注入所有微容器的 ENV

# ---- 基础 ----
ENV_NAME=prod
REGION=cn-east-1
# 生产用 overlay 网络
NETWORK_MODE=overlay

# ---- 中间件 ----
REDIS_HOST=redis.internal
REDIS_PORT=6379
# 生产密码走 secret, 此处引用
REDIS_PASSWORD_FILE=/etc/secrets/redis
MQ_NAMESERVER=rmq-1.internal:9876;rmq-2.internal:9876

# ---- 镜像 ----
# 生产用固定版本号 (合规要求)
IMAGE_TAG=2.14.3
# 生产公司 registry
REGISTRY=registry.example.com

# ---- 仅生产: 合规 ----
SECURITY_SCANNER=true
# 生产禁止 debug
DEBUG=false
GOTRACEBACK=none
# 生产关 pprof
PPROF_ENABLED=false

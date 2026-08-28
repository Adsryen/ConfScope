# -*- coding: utf-8 -*-
"""生成生产级 retest 配置数据（A/B 环境对），覆盖真实生产场景差异。"""
import json, os, urllib.parse, urllib.request

OUT = os.path.dirname(os.path.abspath(__file__))

# ============ 1. svc-gateway.yaml — 大量注释 + 行序差异 + 注释措辞差异 + 值差异 ============
A_YAML_GW = """# =============================================================
# 网关服务主配置 - 开发环境
# 维护人: 平台组 (platform-team)
# 注意: 本文件由 ConfScope 管理, 手工修改前请先在审计日志里记录
# 变更流程: dev -> qa -> prod, 每次同步必须走"应用"按钮
# =============================================================

server:
  # HTTP 监听端口
  port: 8080
  # 优雅停机等待秒数
  graceful-shutdown: 30
  # 开发环境不限制流量
  rate-limit:
    enabled: false
    qps: 10000

# ---- 上游服务列表（顺序即优先级, 故障时按序切换）----
upstreams:
  - name: user-service
    url: http://192.0.2.11:9001
    # 连接池
    pool:
      max: 50
      idle-timeout: 60
    # 熔断阈值
    circuit-breaker:
      failure-ratio: 0.5
      window-size: 10
  - name: order-service
    url: http://192.0.2.12:9002
    pool:
      max: 30
      idle-timeout: 120
    circuit-breaker:
      failure-ratio: 0.3
      window-size: 20

# 路由规则
routes:
  - path: /api/v1/users/**
    upstream: user-service
    strip-prefix: true
  - path: /api/v1/orders/**
    upstream: order-service

# 日志（开发环境输出到控制台, 级别 debug）
logging:
  level: debug
  outputs:
    - console
  # 开发环境不接 ELK
  elk:
    enabled: false

# 可观测性
metrics:
  enabled: true
  # 开发环境 5 秒一拉
  prometheus-scrape-interval: 5

# 安全
security:
  # 开发环境允许明文
  tls:
    enabled: false
  cors:
    # 开发环境允许所有来源
    allowed-origins:
      - "*"

# 多租户（开发只开一个）
tenants:
  - id: dev-tenant
    name: 开发租户
    quota:
      qps: 500
"""
B_YAML_GW = """# =============================================================
# 网关服务主配置 - 生产环境 (QA 预演)
# 维护人: 平台组 (platform-team)
# 注意: 本文件由 ConfScope 管理, 修改需走变更单
# =============================================================

# ---- 上游服务列表（顺序即优先级, 故障时按序切换）----
# 注意: 生产环境 upstreams 在前, 便于 oncall 快速定位
upstreams:
  # 生产连接池更大
  - name: user-service
    url: http://192.0.2.21:9001
    pool:
      max: 200
      idle-timeout: 30
    circuit-breaker:
      failure-ratio: 0.2
      window-size: 30
  - name: order-service
    url: http://192.0.2.22:9002
    pool:
      max: 100
      idle-timeout: 60
    circuit-breaker:
      failure-ratio: 0.2
      window-size: 30
  # 生产多一个库存服务
  - name: inventory-service
    url: http://192.0.2.23:9003
    pool:
      max: 50
      idle-timeout: 60

server:
  # HTTP 监听端口（生产固定 8443）
  port: 8443
  graceful-shutdown: 60
  # 生产开启限流
  rate-limit:
    enabled: true
    qps: 5000

# 路由规则
routes:
  - path: /api/v1/users/**
    upstream: user-service
    strip-prefix: true
  - path: /api/v1/orders/**
    upstream: order-service
  - path: /api/v1/inventory/**
    upstream: inventory-service

# 日志（生产 INFO 起步, 双写 ELK）
logging:
  level: info
  outputs:
    - console
    - file
  elk:
    enabled: true
    endpoint: http://elk.internal:9200
    # 索引前缀
    index-prefix: prod-gateway

# 可观测性
metrics:
  enabled: true
  # 生产 15 秒一拉, 降低 Prometheus 压力
  prometheus-scrape-interval: 15

# 安全
security:
  # 生产强制 TLS
  tls:
    enabled: true
    cert-file: /etc/gateway/tls/server.crt
    key-file: /etc/gateway/tls/server.key
  cors:
    # 生产白名单
    allowed-origins:
      - https://shop.example.com
      - https://admin.example.com

# 多租户（生产两个）
tenants:
  - id: prod-tenant
    name: 生产租户
    quota:
      qps: 2000
  - id: vip-tenant
    name: 大客户租户
    quota:
      qps: 5000
"""

# ============ 2. svc-billing.yaml — B 侧注释掉未启用模块（语义差异）+ 空值 ============
A_YAML_BILLING = """# 计费服务配置 - 开发
# 模块开关: 所有模块默认开启, 便于联调

billing:
  # 计费周期: hourly / daily / monthly
  cycle: hourly
  # 货币
  currency: CNY
  # 保留两位小数
  precision: 2

# 支付渠道（开发只接 mock）
payment:
  mock:
    enabled: true
    delay-ms: 100
  alipay:
    enabled: true
    # 开发用沙箱
    app-id: 2021000000000001
    gateway: https://openapi-sandbox.dl.alipaydev.com/gateway.do
  wechat:
    enabled: true
    mch-id: 1900000001
    # 证书路径
    cert-path: /dev/certs/wechat/apiclient_cert.pem

# 发票
invoice:
  enabled: true
  # 开发用本地生成
  engine: local
  template: simple

# 对账
reconciliation:
  enabled: true
  # 开发每天跑一次
  schedule: "0 2 * * *"
  # 容差（分）
  tolerance: 0

# 结算
settlement:
  enabled: true
  # 开发手动触发
  mode: manual
  # 未启用银行通道
  bank:
    # 开发无真实银企直联
    host: ""
"""
B_YAML_BILLING = """# 计费服务配置 - 生产 (QA 预演)
# 模块开关: 生产按合规要求关闭部分模块

billing:
  # 计费周期: 生产按天
  cycle: daily
  # 货币
  currency: CNY
  # 生产精度提高到 4 位（跨境业务）
  precision: 4

# 支付渠道（生产真实渠道, mock 关闭）
payment:
  mock:
    enabled: false
  alipay:
    enabled: true
    # 生产正式网关
    app-id: 2021000000000099
    gateway: https://openapi.alipay.com/gateway.do
  wechat:
    enabled: true
    mch-id: 1900009999
    cert-path: /prod/certs/wechat/apiclient_cert.pem

# 发票（生产用数电发票平台）
invoice:
  enabled: true
  engine: tax-platform
  # 数电票接口
  endpoint: https://inv.example-tax.com/api
  # 生产关闭本地模板
  template:

# 对账（生产每小时）
reconciliation:
  enabled: true
  schedule: "0 * * * *"
  # 生产容差 1 分, 吸收汇率舍入
  tolerance: 1

# 结算（生产自动 + 银企直联）
settlement:
  enabled: true
  mode: auto
  bank:
    # 生产银企直联
    host: https://ebank.example-bank.com
    # 报文加密
    sign-key: SEC-bank-key-001
"""

# ============ 3. svc-search.yaml — 类型差异（bool vs 字符串）+ 注释行移动 ============
A_YAML_SEARCH = """# 搜索服务 - 开发
app:
  name: search-svc
  # 环境标记
  env: dev

elasticsearch:
  # 开发单机
  nodes:
    - http://127.0.0.1:9200
  # 开发用默认索引
  index: search-dev
  # 开发不开 IK
  ik:
    enabled: false

# 召回策略
recall:
  # "true" 是字符串! 历史遗留, 下游按字符串处理
  fuzzy: "true"
  # 最小词元
  min-should-match: 3
  # 同义词
  synonyms:
    - phone -> mobile, cell
    - 电脑 -> computer

# 缓存
cache:
  # 开发用内存
  type: memory
  ttl-seconds: 60

# 排序
rank:
  # 开发只按相关度
  factors:
    - relevance
  # 不启用商业加权
  commercial-boost: false
"""
B_YAML_SEARCH = """# 搜索服务 - 生产 (QA 预演)
app:
  name: search-svc
  # 环境标记
  env: prod

# 排序（生产把 rank 提前, oncall 常看）
rank:
  # 生产多因子
  factors:
    - relevance
    - sales
    - review-score
  # 生产启用商业加权
  commercial-boost: true

elasticsearch:
  # 生产三节点
  nodes:
    - http://es-1.search.internal:9200
    - http://es-2.search.internal:9200
    - http://es-3.search.internal:9200
  # 生产索引
  index: search-prod
  # 生产开 IK 中文分词
  ik:
    enabled: true

# 召回策略
recall:
  # 生产改为布尔 true（开发侧仍是字符串 "true", 类型不一致!）
  fuzzy: true
  min-should-match: 6
  synonyms:
    - phone -> mobile, cell
    - 电脑 -> computer
    # 生产新增汽车同义词
    - car -> automobile, vehicle

# 缓存（生产 Redis 集群）
cache:
  type: redis
  # 生产 10 分钟
  ttl-seconds: 600
"""

# ============ 4. svc-pay.json — JSON 注释无法用, 用 _comment 键 + 嵌套差异 ============
A_PAY = {
  "_comment": "支付服务配置 - 开发环境; 本文件禁止手工编辑, 走 ConfScope 应用",
  "app": {
    "name": "pay-svc",
    "env": "dev",
    "_note": "开发环境: 所有外部依赖指向 127.0.0.1"
  },
  "database": {
    "host": "127.0.0.1",
    "port": 3306,
    "name": "pay_dev",
    "pool": {"max": 10, "min": 1}
  },
  "channels": {
    "alipay": {"enabled": True, "sandbox": True, "app_id": "DEV-A-001"},
    "wechat": {"enabled": True, "sandbox": True, "mch_id": "1900000001"},
    "unionpay": {"enabled": False, "reason": "开发未签约"}
  },
  "risk": {
    "enabled": True,
    "rules": ["amount>50000", "velocity>10/min"],
    "_note": "开发规则集精简, 只保留两条"
  },
  "retry": {"max": 3, "backoff_ms": 100},
  "audit_log": True
}
B_PAY = {
  "_comment": "支付服务配置 - 生产 (QA 预演); 本文件禁止手工编辑, 走 ConfScope 应用",
  "app": {
    "name": "pay-svc",
    "env": "prod",
    "_note": "生产环境: 依赖全部走内网域名"
  },
  "database": {
    "host": "pay-db.internal",
    "port": 3306,
    "name": "pay_prod",
    "pool": {"max": 100, "min": 10}
  },
  "channels": {
    "alipay": {"enabled": True, "sandbox": False, "app_id": "PROD-A-888"},
    "wechat": {"enabled": True, "sandbox": False, "mch_id": "1900009999"},
    "unionpay": {"enabled": True, "app_id": "UP-PROD-77"},
    "paypal": {"enabled": True, "client_id": "AZxPayPalClient", "_note": "生产新上 PayPal"}
  },
  "risk": {
    "enabled": True,
    "rules": ["amount>10000", "velocity>5/min", "blacklist-hit", "geo-anomaly"],
    "_note": "生产规则集完整, 风控团队维护"
  },
  "retry": {"max": 5, "backoff_ms": 500},
  "audit_log": True,
  "compliance": {"pci-dss": True, "log-retention-days": 180}
}

# ============ 5. svc-pay.properties — properties: 注释差异/值差异/仅一侧存在的 key ============
A_PROPS = """# ============================================================
# 支付服务 JVM/框架级配置 - 开发
# 注意: 本文件由 ConfScope 管理
# ============================================================

# ---- 服务基础 ----
server.port=8080
server.context-path=/pay
# 开发 2C4G 容器
server.tomcat.threads.max=100

# ---- 数据源 ----
spring.datasource.url=jdbc:mysql://127.0.0.1:3306/pay_dev?useSSL=false&serverTimezone=Asia/Shanghai
spring.datasource.username=dev_user
# 开发用简单密码 (测试环境可接受)
spring.datasource.password=dev_pass_123
spring.datasource.hikari.maximum-pool-size=10

# ---- 消息队列 ----
# 开发用本机 RocketMQ
rocketmq.name-server=127.0.0.1:9876
rocketmq.producer.group=pay-dev-producer
# 消费线程
rocketmq.consumer.threads=4

# ---- 日志 ----
# 开发 DEBUG
logging.level.com.pay=DEBUG
# 日志路径
logging.file.path=/var/log/pay/dev

# ---- 缓存 ----
# 开发本地 Caffeine
cache.type=caffeine
cache.expire-seconds=60

# ---- 仅开发存在的 key: mock 开关 ----
mock.payment.enabled=true
mock.payment.delay-ms=200

# 开发无加密密钥 (明文)
crypto.key=
"""
B_PROPS = """# ============================================================
# 支付服务 JVM/框架级配置 - 生产 (QA 预演)
# 注意: 本文件由 ConfScope 管理; 生产密码走 Vault 注入, 此处留空
# ============================================================

# ---- 服务基础 ----
server.port=8443
server.context-path=/pay
# 生产 8C16G, 线程池拉满
server.tomcat.threads.max=400

# ---- 数据源 ----
# 生产走内网域名, 强制 SSL
spring.datasource.url=jdbc:mysql://pay-db.internal:3306/pay_prod?useSSL=true&serverTimezone=Asia/Shanghai
spring.datasource.username=prod_user
# 生产密码由 Vault 在启动时注入, 此值必须留空
spring.datasource.password=
spring.datasource.hikari.maximum-pool-size=100

# ---- 消息队列 ----
# 生产 RocketMQ 集群
rocketmq.name-server=rmq-1.internal:9876;rmq-2.internal:9876
rocketmq.producer.group=pay-prod-producer
# 生产消费线程 32
rocketmq.consumer.threads=32

# ---- 日志 ----
# 生产 INFO
logging.level.com.pay=INFO
logging.file.path=/var/log/pay/prod
# 生产接 ELK
logging.elk.endpoint=http://elk.internal:9200

# ---- 缓存 ----
# 生产 Redis
cache.type=redis
cache.redis.host=cache.internal
# 生产 10 分钟
cache.expire-seconds=600

# ---- 仅生产存在的 key: 合规与加密 ----
compliance.audit.enabled=true
crypto.key=SEC-pay-key-2026
# 报文加密算法
crypto.alg=SM4
"""

# ============ 6. svc-order.toml — TOML 双方都是文本 fallback, 行序/注释/值差异 ============
A_TOML = """# 订单服务 - 开发
# TOML 格式; ConfScope 当前按纯文本对比

[server]
# 开发端口
port = 8080
# 开发不开 TLS
tls = false

[order]
# 订单保留 30 天 (开发)
retention-days = 30
# 自动取消超时(分钟)
cancel-after-minutes = 1440
# 开发单实例
max-instances = 1

[db]
# 开发本机
dsn = "127.0.0.1:3306/order_dev"
# 连接池
pool-max = 10

# 开发特有的实验开关
[experiment]
new-pricing = true
# 实验组
cohort = "dev-all"
"""
B_TOML = """# 订单服务 - 生产 (QA 预演)
# TOML 格式; ConfScope 当前按纯文本对比

# 生产把 [db] 提前 (DBA 习惯先看数据源)
[db]
# 生产内网
dsn = "order-db.internal:3306/order_prod"
# 生产连接池 100
pool-max = 100
# 生产读写分离
read-replica = "order-db-ro.internal:3306"

[server]
# 生产端口
port = 9090
# 生产开 TLS
tls = true
# 生产证书
cert = "/etc/order/tls/cert.pem"

[order]
# 生产保留 1 年
retention-days = 365
# 生产 30 分钟未支付即取消
cancel-after-minutes = 30
# 生产多实例
max-instances = 8

# 生产关闭实验, 全量
[experiment]
new-pricing = false
# 生产无 cohort 概念
# cohort = "prod-all"
"""

# ============ 7. svc-common.env — env 风格, 注释差异 + 值差异 + 仅一侧 ============
A_ENV = """# 公共环境变量 - 开发
# 本文件注入所有微容器的 ENV

# ---- 基础 ----
ENV_NAME=dev
REGION=cn-local
# 开发用本机 docker 网络
NETWORK_MODE=bridge

# ---- 中间件 ----
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
# 开发无密码
REDIS_PASSWORD=
MQ_NAMESERVER=127.0.0.1:9876

# ---- 镜像 ----
# 开发用 latest 标签
IMAGE_TAG=latest
# 开发本地 registry
REGISTRY=127.0.0.1:5000

# ---- 仅开发: 调试 ----
DEBUG=true
GOTRACEBACK=all
# 开发开 pprof
PPROF_ENABLED=true
"""
B_ENV = """# 公共环境变量 - 生产 (QA 预演)
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
"""

# ============ 8. svc-notify.yaml — B 侧 YAML 语法错误（parse_error 场景） ============
A_YAML_NOTIFY = """# 通知服务 - 开发
app:
  name: notify-svc

# 渠道
channels:
  sms:
    enabled: true
    # 开发用 mock 发送
    provider: mock
  email:
    enabled: true
    # 开发 SMTP 本机
    smtp:
      host: 127.0.0.1
      port: 1025
  push:
    enabled: false

# 模板
templates:
  dir: ./templates
  # 开发热加载
  hot-reload: true

# 限流
rate-limit:
  # 开发宽松
  per-minute: 1000
"""
B_YAML_NOTIFY = """# 通知服务 - 生产 (QA 预演)
app:
  name: notify-svc

# 渠道
channels:
  sms:
    enabled: true
    # 生产真实运营商
    provider: aliyun
    # 签名
    sign-name: "示例科技"
  email:
    enabled: true
    smtp:
      host: smtp.example.com
      port: 465
      # 注意: 下一行故意制造缩进错误(制表符混用), 模拟生产手工改坏的场景
    \tssl: true
  push:
    enabled: true
    # 生产接厂商
    vendors:
      - apns
      - fcm

# 模板
templates:
  dir: /opt/notify/templates
  # 生产不热加载
  hot-reload: false

# 限流
rate-limit:
  # 生产严格
  per-minute: 100
  # 生产按租户限流
  per-tenant: true
"""

# ============ 9. svc-config.yaml — 纯注释变化（值全部相同） ============
A_YAML_CFG = """# 公共配置 - 开发
# 本文件各服务共享

common:
  # 时区
  timezone: Asia/Shanghai
  # 语言
  locale: zh-CN
  # 开发环境标识
  env: dev

# 公共依赖版本
deps:
  # 开发锁旧版
  netty: 4.1.80
  # grpc
  grpc: 1.50.0
"""
B_YAML_CFG = """# 公共配置 - 生产 (QA 预演)
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
"""

# ============ 10. svc-data.yaml — 空值场景（null/空字符串/缺失） ============
A_YAML_DATA = """# 数据服务 - 开发
app:
  name: data-svc

storage:
  # 开发本地盘
  type: local
  path: /var/data/dev
  # 开发不限大小
  quota-gb:
  # 备份: 开发不配
  backup:
    # 全部留空
    cron:
    target:

# 数据保留
retention:
  # 开发保留 7 天
  days: 7
  # 归档: 开发不归档
  archive:
    enabled: false
    # 目标留空
    destination:
"""
B_YAML_DATA = """# 数据服务 - 生产 (QA 预演)
app:
  name: data-svc

storage:
  # 生产对象存储
  type: oss
  # 生产 bucket
  path: oss://data-prod-bucket
  # 生产配额 100T
  quota-gb: 102400
  # 备份: 生产开启
  backup:
    # 每天凌晨 2 点
    cron: "0 2 * * *"
    target: oss://data-prod-backup

# 数据保留
retention:
  # 生产保留 1 年
  days: 365
  # 归档: 生产归档到低频
  archive:
    enabled: true
    # 生产归档目标
    destination: oss://data-archive
"""

# ============ 11. svc-auth.json — JSON 数组元素差异 + 仅一侧顶层键 ============
A_AUTH = {
  "name": "auth-svc",
  "env": "dev",
  "jwt": {
    "issuer": "https://auth.dev.example.com",
    "ttl-minutes": 120,
    "rotate-hours": 24
  },
  "oauth": {
    "providers": [
      {"id": "github", "label": "GitHub"},
      {"id": "wechat", "label": "微信"}
    ]
  },
  "mfa": {"enabled": False, "reason": "开发跳过 MFA"},
  "session": {
    "ttl-minutes": 720,
    "concurrent": True
  }
}
B_AUTH = {
  "name": "auth-svc",
  "env": "prod",
  "jwt": {
    "issuer": "https://auth.example.com",
    "ttl-minutes": 30,
    "rotate-hours": 12
  },
  "oauth": {
    "providers": [
      {"id": "github", "label": "GitHub"},
      {"id": "wechat", "label": "微信"},
      {"id": "dingtalk", "label": "钉钉"},
      {"id": "ldap", "label": "企业 AD"}
    ]
  },
  "mfa": {"enabled": True, "methods": ["sms", "totp", "email"]},
  "session": {
    "ttl-minutes": 60,
    "concurrent": False
  },
  "compliance": {
    "audit-all-actions": True,
    "log-retention-days": 365
  }
}

# ============ 12. svc-legacy.yaml — 大文件(200+行) + 行漂移 + 大量注释 ============
def gen_legacy(env, tag):
    lines = []
    ap = lines.append
    ap(f"# ===================================================================")
    ap(f"# 遗留单体服务配置 - {env}")
    ap(f"# 本文件是历史遗留, 模块众多, 正在逐步拆分")
    ap(f"# 维护群: #legacy-migration")
    ap(f"# ===================================================================")
    ap("")
    ap(f"# ---- 模块 1: 用户 ----")
    ap("module.user:")
    ap(f"  # 开发 {'mock 数据' if env=='dev' else '真实数据源'}")
    ap(f"  data-source: {'mock' if env=='dev' else 'db'}")
    ap(f"  cache-ttl: {300 if env=='dev' else 30}")
    ap(f"  # 批量大小")
    ap(f"  batch-size: {10 if env=='dev' else 500}")
    ap("")
    ap("# ---- 模块 2: 订单 ----")
    ap("module.order:")
    ap(f"  enabled: true")
    ap(f"  # 超时(秒)")
    ap(f"  timeout: {30 if env=='dev' else 5}")
    ap(f"  # 重试")
    ap(f"  retry: {3 if env=='dev' else 1}")
    ap("")
    ap("# ---- 模块 3: 报表 ----")
    ap("module.report:")
    ap(f"  # 开发实时, 生产离线")
    ap(f"  mode: {'realtime' if env=='dev' else 'batch'}")
    ap(f"  # 输出目录")
    ap(f"  output: /var/report/{'dev' if env=='dev' else 'prod'}")
    ap("")
    # 中间塞 60 个生成注释行模拟大文件
    for i in range(1, 61):
        ap(f"# legacy note {i}: 模块{i}迁移进度 {'30' if env=='dev' else '70'}% (2026-{(i%12)+1:02d})")
    ap("")
    ap("# ---- 模块 4: 消息 ----")
    ap("module.message:")
    ap(f"  queue: {'local' if env=='dev' else 'rocketmq'}")
    ap(f"  depth: {100 if env=='dev' else 10000}")
    ap("")
    ap("# ---- 模块 5: 定时任务 ----")
    ap("module.cron:")
    ap(f"  # 开发只开一个")
    ap(f"  jobs:")
    if env == 'dev':
        ap("    - name: clean-dev")
        ap(f"      schedule: '0 3 * * *'")
    else:
        ap("    - name: clean")
        ap(f"      schedule: '0 3 * * *'")
        ap("    - name: sync-external")
        ap(f"      schedule: '0 */6 * * *'")
        ap("    - name: archive")
        ap(f"      schedule: '0 4 1 * *'")
    ap("")
    ap("# ---- 通用 ----")
    ap("common:")
    ap(f"  log-level: {'DEBUG' if env=='dev' else 'INFO'}")
    ap(f"  # 监控 {'关闭' if env=='dev' else '开启'}")
    ap(f"  metrics-enabled: {'false' if env=='dev' else 'true'}")
    ap(f"  # tag 标记")
    ap(f"  tag: {tag}")
    return "\n".join(lines) + "\n"

FILES = []
def f(dataId, group, type_, a, b):
    FILES.append(dict(dataId=dataId, group=group, type=type_, a=a, b=b))

f("svc-gateway.yaml",   "DEFAULT_GROUP", "yaml",       A_YAML_GW,   B_YAML_GW)
f("svc-billing.yaml",   "DEFAULT_GROUP", "yaml",       A_YAML_BILLING, B_YAML_BILLING)
f("svc-search.yaml",    "DEFAULT_GROUP", "yaml",       A_YAML_SEARCH, B_YAML_SEARCH)
f("svc-pay.json",       "DEFAULT_GROUP", "json",       json.dumps(A_PAY, ensure_ascii=False, indent=2), json.dumps(B_PAY, ensure_ascii=False, indent=2))
f("svc-pay.properties", "DEFAULT_GROUP", "properties", A_PROPS,     B_PROPS)
f("svc-order.toml",     "DEFAULT_GROUP", "toml",       A_TOML,      B_TOML)
f("svc-common.env",     "DEFAULT_GROUP", "env",        A_ENV,       B_ENV)
f("svc-notify.yaml",    "DEFAULT_GROUP", "yaml",       A_YAML_NOTIFY, B_YAML_NOTIFY)
f("svc-config.yaml",    "DEFAULT_GROUP", "yaml",       A_YAML_CFG,  B_YAML_CFG)
f("svc-data.yaml",      "DEFAULT_GROUP", "yaml",       A_YAML_DATA, B_YAML_DATA)
f("svc-auth.json",      "DEFAULT_GROUP", "json",       json.dumps(A_AUTH, ensure_ascii=False, indent=2), json.dumps(B_AUTH, ensure_ascii=False, indent=2))
f("svc-legacy.yaml",    "DEFAULT_GROUP", "yaml",       gen_legacy("dev","A"), gen_legacy("prod","B"))

# 写文件供检查
os.makedirs(os.path.join(OUT, "generated"), exist_ok=True)
for i, it in enumerate(FILES):
    open(os.path.join(OUT, f"generated/{i:02d}-{it['dataId']}.a"), "w").write(it["a"])
    open(os.path.join(OUT, f"generated/{i:02d}-{it['dataId']}.b"), "w").write(it["b"])
print(f"generated {len(FILES)} pairs")

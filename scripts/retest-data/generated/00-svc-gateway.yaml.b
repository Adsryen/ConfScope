# =============================================================
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
  # HTTP 监听端口（生产固定 8080，与开发一致）
  port: 8080
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

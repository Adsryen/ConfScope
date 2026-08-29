# ============================================================
# 监控探针配置 - 生产 (QA 预演) (DEFAULT_GROUP)
# 所有服务共享的指标/健康检查探针
# ============================================================

# ---- 探针 ----
# 生产用 tcp + http 双探针
probe.type=tcp
probe.http-fallback=true
probe.path=/actuator/health
# 生产探针更频繁
probe.interval=5
probe.timeout=2

# ---- 指标 ----
# 生产全量指标
metrics.expose=full
# 生产上报 Prometheus
prometheus.push=true
prometheus.endpoint=http://prom.internal:9090

# ---- 告警 ----
# 生产告警到值班群
alert.channel=pagerduty
# 生产阈值严格
alert.cpu-threshold=75
alert.mem-threshold=80
# 生产加磁盘告警
alert.disk-threshold=85

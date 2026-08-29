# ============================================================
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

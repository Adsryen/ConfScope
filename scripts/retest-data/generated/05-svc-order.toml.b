# 订单服务 - 生产 (QA 预演)
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

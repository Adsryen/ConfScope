# 数据服务 - 生产 (QA 预演)
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

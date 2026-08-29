# 通知服务 - 生产 (QA 预演)
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
    	ssl: true
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

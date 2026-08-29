# 计费服务配置 - 生产 (QA 预演)
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

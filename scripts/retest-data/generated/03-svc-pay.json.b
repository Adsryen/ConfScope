{
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
    "pool": {
      "max": 100,
      "min": 10
    }
  },
  "channels": {
    "alipay": {
      "enabled": true,
      "sandbox": false,
      "app_id": "PROD-A-888"
    },
    "wechat": {
      "enabled": true,
      "sandbox": false,
      "mch_id": "1900009999"
    },
    "unionpay": {
      "enabled": true,
      "app_id": "UP-PROD-77"
    },
    "paypal": {
      "enabled": true,
      "client_id": "AZxPayPalClient",
      "_note": "生产新上 PayPal"
    }
  },
  "risk": {
    "enabled": true,
    "rules": [
      "amount>10000",
      "velocity>5/min",
      "blacklist-hit",
      "geo-anomaly"
    ],
    "_note": "生产规则集完整, 风控团队维护"
  },
  "retry": {
    "max": 5,
    "backoff_ms": 500
  },
  "audit_log": true,
  "compliance": {
    "pci-dss": true,
    "log-retention-days": 180
  }
}
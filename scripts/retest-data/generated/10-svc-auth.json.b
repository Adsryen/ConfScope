{
  "name": "auth-svc",
  "env": "prod",
  "jwt": {
    "issuer": "https://auth.example.com",
    "ttl-minutes": 30,
    "rotate-hours": 12
  },
  "oauth": {
    "providers": [
      {
        "id": "github",
        "label": "GitHub"
      },
      {
        "id": "wechat",
        "label": "微信"
      },
      {
        "id": "dingtalk",
        "label": "钉钉"
      },
      {
        "id": "ldap",
        "label": "企业 AD"
      }
    ]
  },
  "mfa": {
    "enabled": true,
    "methods": [
      "sms",
      "totp",
      "email"
    ]
  },
  "session": {
    "ttl-minutes": 60,
    "concurrent": false
  },
  "compliance": {
    "audit-all-actions": true,
    "log-retention-days": 365
  }
}
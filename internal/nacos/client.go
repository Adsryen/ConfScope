// Package nacos 封装 Nacos OpenAPI 访问逻辑。
//
// 客户端同时兼容 Nacos 1.x/2.x 的 v1 API 和 Nacos 3.x 的 v3 API：
// v1 使用 tenant/group 参数且 accessToken 放在 query 中，v3 使用
// namespaceId/groupName 参数且 accessToken 放在 header 中。
package nacos

import (
	"crypto/tls"
	"net/http"
	"time"
)

const timeout = 15 * time.Second

// Client 是 Nacos HTTP 客户端。
//
// Client 不保存登录态；accessToken 的缓存和刷新由前端 API 层负责，这里只根据传入
// 的 token 和 API 版本发起请求并归一化响应。
type Client struct {
	http    *http.Client
	mseAuth MSEAuth
	clock   func() time.Time
}

// NewClient 创建 Nacos HTTP 客户端。
//
// 为了兼容内网自签名证书，这里保持与原 Rust 版本一致的策略：允许无效 TLS 证书。
func NewClient() *Client {
	return &Client{
		http: &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // Keep compatibility with existing self-signed Nacos deployments.
			},
		},
		clock: time.Now,
	}
}

func (c *Client) SetMSEAuth(auth MSEAuth) {
	c.mseAuth = auth
}

func (c *Client) WithMSEAuth(auth MSEAuth) *Client {
	next := *c
	next.mseAuth = auth
	if next.clock == nil {
		next.clock = time.Now
	}
	return &next
}

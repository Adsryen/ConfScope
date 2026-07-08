package consul

import (
	"bytes"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const timeout = 15 * time.Second

// Client 是 Consul HTTP API 客户端。
type Client struct {
	http *http.Client
}

// NewClient 创建 Consul HTTP API 客户端。
//
// 为了兼容内网自签名部署，这里保持和 Nacos/Apollo 客户端一致的 TLS 策略。
func NewClient() *Client {
	return newClientWithProxy(false)
}

// NewClientWithProxy 创建使用环境变量代理的 Consul HTTP API 客户端。
func NewClientWithProxy() *Client {
	return newClientWithProxy(true)
}

func newClientWithProxy(useProxy bool) *Client {
	var proxyFunc func(*http.Request) (*url.URL, error)
	if useProxy {
		proxyFunc = http.ProxyFromEnvironment
	}
	return &Client{
		http: &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // 兼容内网自签名 Consul 部署。
				Proxy:           proxyFunc,
			},
		},
	}
}

// Datacenters 列出 Consul datacenter。
func (c *Client) Datacenters(baseURL, token string) ([]string, error) {
	var datacenters []string
	if err := c.getJSON(baseURL, token, "/v1/catalog/datacenters", nil, &datacenters); err != nil {
		return nil, err
	}
	return datacenters, nil
}

// ListKV 递归列出指定 prefix 下的 Consul KV。
func (c *Client) ListKV(baseURL, token, datacenter, prefix string) ([]KVPair, error) {
	query := url.Values{}
	query.Set("recurse", "true")
	setNonEmpty(query, "dc", datacenter)
	var pairs []KVPair
	if err := c.getJSON(baseURL, token, kvPath(prefix), query, &pairs); err != nil {
		return nil, err
	}
	return pairs, nil
}

// GetKV 读取单个 Consul KV。
func (c *Client) GetKV(baseURL, token, datacenter, key string) (KVPair, error) {
	query := url.Values{}
	setNonEmpty(query, "dc", datacenter)
	var pairs []KVPair
	if err := c.getJSON(baseURL, token, kvPath(key), query, &pairs); err != nil {
		return KVPair{}, err
	}
	if len(pairs) == 0 {
		return KVPair{}, fmt.Errorf("Consul key 不存在: %s", key)
	}
	return pairs[0], nil
}

// PutKV 使用 Consul CAS 写入 KV。
func (c *Client) PutKV(baseURL, token, datacenter, key, value string, cas uint64) error {
	query := url.Values{}
	setNonEmpty(query, "dc", datacenter)
	query.Set("cas", strconv.FormatUint(cas, 10))
	ok, err := c.doBool(baseURL, token, http.MethodPut, kvPath(key), query, bytes.NewBufferString(value))
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("Consul CAS 冲突，目标已变化: %s", key)
	}
	return nil
}

// DeleteKV 使用 Consul CAS 删除 KV。
func (c *Client) DeleteKV(baseURL, token, datacenter, key string, cas uint64) error {
	query := url.Values{}
	setNonEmpty(query, "dc", datacenter)
	query.Set("cas", strconv.FormatUint(cas, 10))
	ok, err := c.doBool(baseURL, token, http.MethodDelete, kvPath(key), query, nil)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("Consul CAS 冲突，目标已变化: %s", key)
	}
	return nil
}

// DecodeValue 解码 Consul KV 的 base64 value，并拒绝非文本内容。
func DecodeValue(pair KVPair) (string, error) {
	data, err := base64.StdEncoding.DecodeString(pair.Value)
	if err != nil {
		return "", fmt.Errorf("解码 Consul KV value 失败: %w", err)
	}
	if !utf8.Valid(data) {
		return "", fmt.Errorf("Consul KV value 不是可显示文本: %s", pair.Key)
	}
	return string(data), nil
}

func (c *Client) doBool(baseURL, token, method, path string, query url.Values, body io.Reader) (bool, error) {
	reqURL := strings.TrimRight(baseURL, "/") + path
	if len(query) > 0 {
		reqURL += "?" + query.Encode()
	}
	req, err := http.NewRequest(method, reqURL, body)
	if err != nil {
		return false, err
	}
	if token != "" {
		req.Header.Set("X-Consul-Token", token)
	}
	if method == http.MethodPut {
		req.Header.Set("Content-Type", "text/plain;charset=UTF-8")
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return false, fmt.Errorf("Consul 请求失败: %w", err)
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, fmt.Errorf("读取 Consul 响应失败: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return false, fmt.Errorf("Consul 返回 %d，请求 %s: %s", resp.StatusCode, requestPath(req), strings.TrimSpace(string(responseBody)))
	}
	var ok bool
	if err := json.Unmarshal(responseBody, &ok); err != nil {
		return false, fmt.Errorf("解析 Consul 写入响应失败: %w —— %s", err, strings.TrimSpace(string(responseBody)))
	}
	return ok, nil
}

func (c *Client) getJSON(baseURL, token, path string, query url.Values, target any) error {
	reqURL := strings.TrimRight(baseURL, "/") + path
	if len(query) > 0 {
		reqURL += "?" + query.Encode()
	}
	req, err := http.NewRequest(http.MethodGet, reqURL, nil)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("X-Consul-Token", token)
	}
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("Consul 请求失败: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("读取 Consul 响应失败: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Consul 返回 %d，请求 %s: %s", resp.StatusCode, requestPath(req), strings.TrimSpace(string(body)))
	}
	if err := json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("解析 Consul 响应 JSON 失败: %w —— %s", err, strings.TrimSpace(string(body)))
	}
	return nil
}

func kvPath(key string) string {
	key = strings.TrimLeft(key, "/")
	if key == "" {
		return "/v1/kv/"
	}
	parts := strings.Split(key, "/")
	for i, part := range parts {
		parts[i] = url.PathEscape(part)
	}
	return "/v1/kv/" + strings.Join(parts, "/")
}

func requestPath(req *http.Request) string {
	if req == nil || req.URL == nil {
		return ""
	}
	return req.URL.Path
}

func setNonEmpty(values url.Values, key, value string) {
	if strings.TrimSpace(value) != "" {
		values.Set(key, strings.TrimSpace(value))
	}
}

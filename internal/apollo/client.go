package apollo

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const timeout = 15 * time.Second

// Client 是 Apollo OpenAPI HTTP 客户端。
type Client struct {
	http *http.Client
}

// NewClient 创建 Apollo OpenAPI HTTP 客户端。
//
// 为了兼容内网自签名部署，这里保持和 Nacos 客户端一致的 TLS 策略。
func NewClient() *Client {
	return newClientWithProxy(false)
}

// NewClientWithProxy 创建使用环境变量代理的 Apollo OpenAPI HTTP 客户端。
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
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // 兼容内网自签名 Apollo 部署。
				Proxy:           proxyFunc,
			},
		},
	}
}

// ListNamespaces 列出指定 app/cluster 下的 Apollo namespace。
func (c *Client) ListNamespaces(baseURL, token, env, appID, clusterName string) ([]Namespace, error) {
	path := fmt.Sprintf(
		"/openapi/v1/envs/%s/apps/%s/clusters/%s/namespaces",
		url.PathEscape(env),
		url.PathEscape(appID),
		url.PathEscape(clusterName),
	)
	var namespaces []Namespace
	if err := c.getJSON(baseURL, token, path, &namespaces); err != nil {
		return nil, err
	}
	return namespaces, nil
}

// GetNamespace 读取指定 Apollo namespace 详情。
func (c *Client) GetNamespace(baseURL, token, env, appID, clusterName, namespaceName string) (Namespace, error) {
	path := fmt.Sprintf(
		"/openapi/v1/envs/%s/apps/%s/clusters/%s/namespaces/%s",
		url.PathEscape(env),
		url.PathEscape(appID),
		url.PathEscape(clusterName),
		url.PathEscape(namespaceName),
	)
	var namespace Namespace
	if err := c.getJSON(baseURL, token, path, &namespace); err != nil {
		return Namespace{}, err
	}
	if namespace.Items == nil {
		return Namespace{}, fmt.Errorf("Apollo namespace 响应缺少 items 数组")
	}
	return namespace, nil
}

// UpsertItem 创建或更新 Apollo namespace 中的单个配置项。
func (c *Client) UpsertItem(baseURL, token, env, appID, clusterName, namespaceName, key, value, operator string) error {
	path := fmt.Sprintf(
		"/openapi/v1/envs/%s/apps/%s/clusters/%s/namespaces/%s/items/%s",
		url.PathEscape(env),
		url.PathEscape(appID),
		url.PathEscape(clusterName),
		url.PathEscape(namespaceName),
		url.PathEscape(key),
	)
	query := url.Values{}
	query.Set("createIfNotExists", "true")
	body := map[string]string{
		"key":                      key,
		"value":                    value,
		"comment":                  "ConfScope ApplyPlan",
		"dataChangeLastModifiedBy": operator,
		"dataChangeCreatedBy":      operator,
	}
	return c.doJSON(baseURL, token, http.MethodPut, path, query, body, nil)
}

// DeleteItem 删除 Apollo namespace 中的单个配置项。
func (c *Client) DeleteItem(baseURL, token, env, appID, clusterName, namespaceName, key, operator string) error {
	path := fmt.Sprintf(
		"/openapi/v1/envs/%s/apps/%s/clusters/%s/namespaces/%s/items/%s",
		url.PathEscape(env),
		url.PathEscape(appID),
		url.PathEscape(clusterName),
		url.PathEscape(namespaceName),
		url.PathEscape(key),
	)
	query := url.Values{}
	query.Set("operator", operator)
	return c.doJSON(baseURL, token, http.MethodDelete, path, query, nil, nil)
}

// ReleaseNamespace 发布 Apollo namespace 的当前未发布变更。
func (c *Client) ReleaseNamespace(baseURL, token, env, appID, clusterName, namespaceName, title, comment, operator string) error {
	path := fmt.Sprintf(
		"/openapi/v1/envs/%s/apps/%s/clusters/%s/namespaces/%s/releases",
		url.PathEscape(env),
		url.PathEscape(appID),
		url.PathEscape(clusterName),
		url.PathEscape(namespaceName),
	)
	body := map[string]string{
		"releaseTitle":   title,
		"releaseComment": comment,
		"releasedBy":     operator,
	}
	return c.doJSON(baseURL, token, http.MethodPost, path, nil, body, nil)
}

func (c *Client) getJSON(baseURL, token, path string, target any) error {
	return c.doJSON(baseURL, token, http.MethodGet, path, nil, nil, target)
}

func (c *Client) doJSON(baseURL, token, method, path string, query url.Values, requestBody any, target any) error {
	reqURL := strings.TrimRight(baseURL, "/") + path
	if len(query) > 0 {
		reqURL += "?" + query.Encode()
	}
	var reader io.Reader
	if requestBody != nil {
		data, err := json.Marshal(requestBody)
		if err != nil {
			return fmt.Errorf("编码 Apollo 请求 JSON 失败: %w", err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, reqURL, reader)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", token)
	}
	req.Header.Set("Accept", "application/json")
	if requestBody != nil {
		req.Header.Set("Content-Type", "application/json;charset=UTF-8")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("Apollo 请求失败: %w", err)
	}
	defer resp.Body.Close()

	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("读取 Apollo 响应失败: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("Apollo 返回 %d，请求 %s: %s", resp.StatusCode, requestPath(req), strings.TrimSpace(string(responseBody)))
	}
	if target == nil {
		return nil
	}
	if err := json.Unmarshal(responseBody, target); err != nil {
		return fmt.Errorf("解析 Apollo 响应 JSON 失败: %w —— %s", err, strings.TrimSpace(string(responseBody)))
	}
	return nil
}

func requestPath(req *http.Request) string {
	if req == nil || req.URL == nil {
		return ""
	}
	return req.URL.Path
}

package nacos

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func base(baseURL string) string {
	return strings.TrimRight(baseURL, "/")
}

func requestPath(req *http.Request) string {
	if req == nil || req.URL == nil {
		return ""
	}
	if req.URL.RawQuery == "" {
		return req.URL.Path
	}
	return req.URL.Path + "?" + req.URL.RawQuery
}

func requestURL(baseURL, path string, query url.Values) string {
	reqURL := base(baseURL) + path
	if encoded := query.Encode(); encoded != "" {
		reqURL += "?" + encoded
	}
	return reqURL
}

func shouldRetryWithNacosContext(baseURL, path string, statusCode int) bool {
	if statusCode != http.StatusNotFound || strings.HasPrefix(path, "/nacos/") {
		return false
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return false
	}
	contextPath := strings.TrimRight(parsed.Path, "/")
	return contextPath == "" || contextPath == "/"
}

func (c *Client) getText(baseURL, path string, query url.Values, accessToken string, version apiVersion) (string, error) {
	var lastErr error
	for retry := 0; retry < maxRetries; retry++ {
		if retry > 0 {
			time.Sleep(retryBackoff(retry - 1))
		}
		text, httpErr, statusCode := c.getTextOnce(baseURL, path, query, accessToken, version)
		if httpErr == nil {
			return text, nil
		}
		if !isRetryable(httpErr, statusCode) {
			return "", httpErr
		}
		lastErr = httpErr
	}
	return "", fmt.Errorf("请求失败（已重试 %d 次）: %w", maxRetries, lastErr)
}

// getTextOnce 执行单次 GET 请求（含 context-path 404 回退重试）。
func (c *Client) getTextOnce(baseURL, path string, query url.Values, accessToken string, version apiVersion) (string, error, int) {
	if version == apiV1 && accessToken != "" {
		query.Set("accessToken", accessToken)
	}

	for attempt := 0; attempt < 2; attempt++ {
		currentPath := path
		if attempt == 1 {
			currentPath = "/nacos" + path
		}
		req, err := http.NewRequest(http.MethodGet, requestURL(baseURL, currentPath, query), nil)
		if err != nil {
			return "", err, 0
		}
		if version == apiV3 && accessToken != "" {
			req.Header.Set("accessToken", accessToken)
		}
		c.applyMSEAuth(req, requestNamespace(query, nil), requestGroup(query, nil))
		resp, err := c.http.Do(req)
		if err != nil {
			return "", fmt.Errorf("请求失败: %w", err), 0
		}
		text, err := readBody(resp)
		resp.Body.Close()
		if err != nil {
			return "", fmt.Errorf("读取响应失败: %w", err), resp.StatusCode
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return text, nil, resp.StatusCode
		}
		if attempt == 0 && shouldRetryWithNacosContext(baseURL, path, resp.StatusCode) {
			continue
		}
		return "", fmt.Errorf("Nacos 返回 %d，请求 %s: %s", resp.StatusCode, requestPath(req), truncate(text)), resp.StatusCode
	}
	return "", fmt.Errorf("请求失败"), 404
}

func (c *Client) getJSON(baseURL, path string, query url.Values, accessToken string, version apiVersion) (any, error) {
	text, err := c.getText(baseURL, path, query, accessToken, version)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, fmt.Errorf("解析响应 JSON 失败: %w —— %s", err, truncate(text))
	}
	if version == apiV3 {
		obj := asObject(v)
		if obj != nil {
			if _, ok := obj["code"]; ok {
				if i(obj, "code") != 0 {
					return nil, fmt.Errorf("Nacos 返回 code=%d: %s", i(obj, "code"), s(obj, "message"))
				}
				return obj["data"], nil
			}
		}
	}
	return v, nil
}

func (c *Client) sendForm(method, baseURL, path string, query url.Values, form url.Values, accessToken string, version apiVersion) (string, error) {
	var lastErr error
	for retry := 0; retry < maxRetries; retry++ {
		if retry > 0 {
			time.Sleep(retryBackoff(retry - 1))
		}
		text, httpErr, statusCode := c.sendFormOnce(method, baseURL, path, query, form, accessToken, version)
		if httpErr == nil {
			return text, nil
		}
		if !isRetryable(httpErr, statusCode) {
			return "", httpErr
		}
		lastErr = httpErr
	}
	return "", fmt.Errorf("请求失败（已重试 %d 次）: %w", maxRetries, lastErr)
}

// sendFormOnce 执行单次 form-encoded 请求（含 context-path 404 回退重试）。
func (c *Client) sendFormOnce(method, baseURL, path string, query url.Values, form url.Values, accessToken string, version apiVersion) (string, error, int) {
	if version == apiV1 && accessToken != "" {
		query.Set("accessToken", accessToken)
	}

	for attempt := 0; attempt < 2; attempt++ {
		currentPath := path
		if attempt == 1 {
			currentPath = "/nacos" + path
		}
		var body io.Reader
		if form != nil {
			body = bytes.NewBufferString(form.Encode())
		}
		req, err := http.NewRequest(method, requestURL(baseURL, currentPath, query), body)
		if err != nil {
			return "", err, 0
		}
		if form != nil {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
		if version == apiV3 && accessToken != "" {
			req.Header.Set("accessToken", accessToken)
		}
		c.applyMSEAuth(req, requestNamespace(query, form), requestGroup(query, form))
		resp, err := c.http.Do(req)
		if err != nil {
			switch method {
			case http.MethodPost:
				return "", fmt.Errorf("发布请求失败: %w", err), 0
			case http.MethodDelete:
				return "", fmt.Errorf("删除请求失败: %w", err), 0
			default:
				return "", fmt.Errorf("请求失败: %w", err), 0
			}
		}
		text, err := readBody(resp)
		resp.Body.Close()
		if err != nil {
			return "", fmt.Errorf("读取响应失败: %w", err), resp.StatusCode
		}
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return text, nil, resp.StatusCode
		}
		if attempt == 0 && shouldRetryWithNacosContext(baseURL, path, resp.StatusCode) {
			continue
		}
		return "", fmt.Errorf("Nacos 返回 %d，请求 %s: %s", resp.StatusCode, requestPath(req), truncate(text)), resp.StatusCode
	}
	return "", fmt.Errorf("请求失败"), 404
}

func readBody(resp *http.Response) (string, error) {
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return string(body), nil
}

func requestNamespace(query url.Values, form url.Values) string {
	return firstValue(query, form, "tenant", "namespaceId")
}

func requestGroup(query url.Values, form url.Values) string {
	return firstValue(query, form, "group", "groupName")
}

func firstValue(query url.Values, form url.Values, keys ...string) string {
	for _, key := range keys {
		if query != nil {
			if value := query.Get(key); value != "" {
				return value
			}
		}
		if form != nil {
			if value := form.Get(key); value != "" {
				return value
			}
		}
	}
	return ""
}

// ── 网络层重试 ──

const maxRetries = 3

// isRetryable 判断错误或 HTTP 状态码是否应触发重试。
func isRetryable(err error, statusCode int) bool {
	if err != nil {
		var netErr net.Error
		if errors.As(err, &netErr) {
			return netErr.Timeout() || netErr.Temporary()
		}
		msg := err.Error()
		if strings.Contains(msg, "EOF") ||
			strings.Contains(msg, "connection reset") ||
			strings.Contains(msg, "broken pipe") ||
			strings.Contains(msg, "forcibly closed") {
			return true
		}
		return false
	}
	return statusCode == 502 || statusCode == 503 || statusCode == 504 || statusCode == 429
}

// retryBackoff 返回第 attempt 次重试的等待时间（指数退避：500ms → 1s → 2s）。
func retryBackoff(attempt int) time.Duration {
	return time.Duration(1<<uint(attempt+1)) * 250 * time.Millisecond
}

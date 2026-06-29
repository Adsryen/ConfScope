package nacos

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// base 规整 Nacos base URL，避免拼接路径时出现重复斜杠。
func base(baseURL string) string {
	return strings.TrimRight(baseURL, "/")
}

// getText 发起 GET 请求并返回响应文本。
//
// accessToken 的传递方式由 API 版本决定：v1 放 query，v3 放 header。
func (c *Client) getText(baseURL, path string, query url.Values, accessToken string, version apiVersion) (string, error) {
	if version == apiV1 && accessToken != "" {
		query.Set("accessToken", accessToken)
	}
	reqURL := base(baseURL) + path
	if encoded := query.Encode(); encoded != "" {
		reqURL += "?" + encoded
	}
	req, err := http.NewRequest(http.MethodGet, reqURL, nil)
	if err != nil {
		return "", err
	}
	if version == apiV3 && accessToken != "" {
		req.Header.Set("accessToken", accessToken)
	}
	c.applyMSEAuth(req, requestNamespace(query, nil), requestGroup(query, nil))
	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("请求失败: %w", err)
	}
	defer resp.Body.Close()
	text, err := readBody(resp)
	if err != nil {
		return "", fmt.Errorf("读取响应失败: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("Nacos 返回 %d: %s", resp.StatusCode, truncate(text))
	}
	return text, nil
}

// getJSON 发起 GET 请求并解析 JSON。
//
// 对 v3 响应会自动解开 {code,message,data} 信封，并在 code 非 0 时返回业务错误。
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

// sendForm 发起带表单或 query 参数的变更请求。
//
// 当前用于发布和删除配置；不同 HTTP 方法的网络错误会转换为更贴近用户操作的中文提示。
func (c *Client) sendForm(method, baseURL, path string, query url.Values, form url.Values, accessToken string, version apiVersion) (string, error) {
	if version == apiV1 && accessToken != "" {
		query.Set("accessToken", accessToken)
	}
	reqURL := base(baseURL) + path
	if encoded := query.Encode(); encoded != "" {
		reqURL += "?" + encoded
	}

	var body io.Reader
	if form != nil {
		body = bytes.NewBufferString(form.Encode())
	}
	req, err := http.NewRequest(method, reqURL, body)
	if err != nil {
		return "", err
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
			return "", fmt.Errorf("发布请求失败: %w", err)
		case http.MethodDelete:
			return "", fmt.Errorf("删除请求失败: %w", err)
		default:
			return "", fmt.Errorf("请求失败: %w", err)
		}
	}
	defer resp.Body.Close()
	text, err := readBody(resp)
	if err != nil {
		return "", fmt.Errorf("读取响应失败: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("Nacos 返回 %d: %s", resp.StatusCode, truncate(text))
	}
	return text, nil
}

// readBody 读取响应体并转换为字符串。
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

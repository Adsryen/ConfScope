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
		return "", fmt.Errorf("Nacos 返回 %d，请求 %s: %s", resp.StatusCode, requestPath(req), truncate(text))
	}
	return text, nil
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
		return "", fmt.Errorf("Nacos 返回 %d，请求 %s: %s", resp.StatusCode, requestPath(req), truncate(text))
	}
	return text, nil
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

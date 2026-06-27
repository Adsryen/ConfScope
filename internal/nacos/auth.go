package nacos

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// DetectVersion 探测 Nacos API 版本。
//
// v3 的命名空间接口存在时，Nacos 可能返回 200、400 或 403；只有明确 404 时才认为是 v1。
func (c *Client) DetectVersion(baseURL string) (string, error) {
	resp, err := c.http.Get(base(baseURL) + "/v3/console/core/namespace/list")
	if err != nil {
		return "", fmt.Errorf("无法连接到服务器: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return string(apiV1), nil
	}
	return string(apiV3), nil
}

// Login 登录 Nacos 并归一化 token 响应。
//
// v1/v3 登录响应多数是裸对象，部分版本会包在 data 字段中，这里做兼容处理。
func (c *Client) Login(baseURL, username, password, apiVersion string) (LoginResult, error) {
	version := parseAPI(apiVersion)
	path := "/v1/auth/login"
	if version == apiV3 {
		path = "/v3/auth/user/login"
	}

	form := url.Values{}
	form.Set("username", username)
	form.Set("password", password)
	req, err := http.NewRequest(http.MethodPost, base(baseURL)+path, strings.NewReader(form.Encode()))
	if err != nil {
		return LoginResult{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.http.Do(req)
	if err != nil {
		return LoginResult{}, fmt.Errorf("登录请求失败: %w", err)
	}
	defer resp.Body.Close()
	text, err := readBody(resp)
	if err != nil {
		return LoginResult{}, fmt.Errorf("读取登录响应失败: %w", err)
	}
	if resp.StatusCode == http.StatusForbidden {
		return LoginResult{}, fmt.Errorf("账号或密码错误（Nacos 返回 403）")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return LoginResult{}, fmt.Errorf("登录失败 %d: %s", resp.StatusCode, truncate(text))
	}

	v, err := decodeJSON(text)
	if err != nil {
		return LoginResult{}, fmt.Errorf("解析登录响应失败: %w —— %s", err, truncate(text))
	}
	body := v
	if _, ok := v["accessToken"]; !ok {
		if data := asObject(v["data"]); data != nil {
			body = data
		}
	}
	return LoginResult{
		AccessToken: s(body, "accessToken"),
		TokenTtl:    i(body, "tokenTtl"),
		GlobalAdmin: boolValue(body, "globalAdmin"),
	}, nil
}

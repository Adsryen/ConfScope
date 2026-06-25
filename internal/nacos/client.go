// Package nacos 封装 Nacos OpenAPI 访问逻辑。
//
// 客户端同时兼容 Nacos 1.x/2.x 的 v1 API 和 Nacos 3.x 的 v3 API：
// v1 使用 tenant/group 参数且 accessToken 放在 query 中，v3 使用
// namespaceId/groupName 参数且 accessToken 放在 header 中。
package nacos

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const timeout = 15 * time.Second

type apiVersion string

const (
	apiV1 apiVersion = "v1"
	apiV3 apiVersion = "v3"
)

// Client 是 Nacos HTTP 客户端。
//
// Client 不保存登录态；accessToken 的缓存和刷新由前端 API 层负责，这里只根据传入
// 的 token 和 API 版本发起请求并归一化响应。
type Client struct {
	http *http.Client
}

// LoginResult 是 Nacos 登录接口归一化后的返回值。
type LoginResult struct {
	AccessToken string `json:"accessToken"`
	TokenTtl    int64  `json:"tokenTtl"`
	GlobalAdmin bool   `json:"globalAdmin"`
}

// Namespace 是 Nacos 命名空间的前端展示模型。
type Namespace struct {
	Namespace         string `json:"namespace"`
	NamespaceShowName string `json:"namespaceShowName"`
	ConfigCount       int64  `json:"configCount"`
	Kind              int64  `json:"kind"`
}

// ConfigItem 是配置列表中的单条配置摘要。
type ConfigItem struct {
	DataId     string `json:"dataId"`
	Group      string `json:"group"`
	Content    string `json:"content"`
	ConfigType string `json:"configType"`
}

// ConfigPage 是配置列表分页结果。
type ConfigPage struct {
	TotalCount     int64        `json:"totalCount"`
	PageNumber     int64        `json:"pageNumber"`
	PagesAvailable int64        `json:"pagesAvailable"`
	PageItems      []ConfigItem `json:"pageItems"`
}

// HistoryItem 是配置历史列表中的单条历史摘要。
type HistoryItem struct {
	Id               string `json:"id"`
	DataId           string `json:"dataId"`
	Group            string `json:"group"`
	OpType           string `json:"opType"`
	LastModifiedTime string `json:"lastModifiedTime"`
}

// HistoryPage 是配置历史分页结果。
type HistoryPage struct {
	TotalCount     int64         `json:"totalCount"`
	PageNumber     int64         `json:"pageNumber"`
	PagesAvailable int64         `json:"pagesAvailable"`
	PageItems      []HistoryItem `json:"pageItems"`
}

// HistoryDetail 是配置历史详情。
type HistoryDetail struct {
	Id               string `json:"id"`
	DataId           string `json:"dataId"`
	Group            string `json:"group"`
	Content          string `json:"content"`
	OpType           string `json:"opType"`
	CreatedTime      string `json:"createdTime"`
	LastModifiedTime string `json:"lastModifiedTime"`
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
	}
}

// parseAPI 将前端传入的版本字符串规整为内部枚举，无法识别时按 v1 处理。
func parseAPI(version string) apiVersion {
	if strings.EqualFold(version, string(apiV3)) {
		return apiV3
	}
	return apiV1
}

// base 规整 Nacos base URL，避免拼接路径时出现重复斜杠。
func base(baseURL string) string {
	return strings.TrimRight(baseURL, "/")
}

// truncate 截断过长的 Nacos 响应文本，用于错误信息展示。
func truncate(text string) string {
	text = strings.TrimSpace(text)
	if len([]rune(text)) <= 300 {
		return text
	}
	runes := []rune(text)
	return string(runes[:300]) + "..."
}

// stringValue 将 Nacos 宽松 JSON 字段转换为字符串。
//
// Nacos 不同版本可能把 id、时间等字段返回为字符串或数字，统一转为字符串后交给前端展示。
func stringValue(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		if x == float64(int64(x)) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	case json.Number:
		return x.String()
	default:
		return ""
	}
}

// s 读取对象中的字符串字段，缺失时返回空字符串。
func s(obj map[string]any, key string) string {
	if obj == nil {
		return ""
	}
	return stringValue(obj[key])
}

// sAny 按顺序读取多个候选字段，返回第一个非空值。
//
// 该函数主要用于兼容 v1/v3 字段名差异，例如 group/groupName、tenant/namespaceId。
func sAny(obj map[string]any, keys ...string) string {
	for _, key := range keys {
		if val := s(obj, key); val != "" {
			return val
		}
	}
	return ""
}

// i 读取对象中的整数字段，缺失或解析失败时返回 0。
func i(obj map[string]any, key string) int64 {
	if obj == nil {
		return 0
	}
	switch x := obj[key].(type) {
	case float64:
		return int64(x)
	case json.Number:
		n, _ := x.Int64()
		return n
	case string:
		n, _ := strconv.ParseInt(x, 10, 64)
		return n
	default:
		return 0
	}
}

// boolValue 读取对象中的布尔字段，缺失或类型不匹配时返回 false。
func boolValue(obj map[string]any, key string) bool {
	if obj == nil {
		return false
	}
	v, _ := obj[key].(bool)
	return v
}

// asObject 将任意 JSON 值转换为对象，类型不匹配时返回 nil。
func asObject(v any) map[string]any {
	obj, _ := v.(map[string]any)
	return obj
}

// asArray 将任意 JSON 值转换为数组，类型不匹配时返回 nil。
func asArray(v any) []any {
	arr, _ := v.([]any)
	return arr
}

// decodeJSON 将响应文本解析为 JSON 对象，并保留数字精度。
func decodeJSON(text string) (map[string]any, error) {
	var v map[string]any
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

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

// Namespaces 查询命名空间列表并归一化字段名。
func (c *Client) Namespaces(baseURL, accessToken, apiVersion string) ([]Namespace, error) {
	version := parseAPI(apiVersion)
	path := "/v1/console/namespaces"
	if version == apiV3 {
		path = "/v3/console/core/namespace/list"
	}
	data, err := c.getJSON(baseURL, path, url.Values{}, accessToken, version)
	if err != nil {
		return nil, err
	}

	items := asArray(data)
	if items == nil {
		items = asArray(asObject(data)["data"])
	}
	if items == nil {
		return nil, fmt.Errorf("命名空间响应缺少 data 数组")
	}

	namespaces := make([]Namespace, 0, len(items))
	for _, item := range items {
		n := asObject(item)
		namespaces = append(namespaces, Namespace{
			Namespace:         sAny(n, "namespace", "namespaceId"),
			NamespaceShowName: s(n, "namespaceShowName"),
			ConfigCount:       i(n, "configCount"),
			Kind:              i(n, "type"),
		})
	}
	return namespaces, nil
}

// ListConfigs 按条件分页查询配置列表。
//
// v1 使用 /v1/cs/configs，v3 使用 /v3/console/cs/config/list；返回值统一为 ConfigPage。
func (c *Client) ListConfigs(baseURL, accessToken, apiVersion, namespace, dataID, group string, pageNo, pageSize int64) (ConfigPage, error) {
	version := parseAPI(apiVersion)
	query := url.Values{}
	query.Set("search", "blur")
	query.Set("dataId", dataID)
	query.Set("pageNo", strconv.FormatInt(pageNo, 10))
	query.Set("pageSize", strconv.FormatInt(pageSize, 10))

	path := "/v1/cs/configs"
	if version == apiV3 {
		path = "/v3/console/cs/config/list"
		query.Set("groupName", group)
		query.Set("namespaceId", namespace)
	} else {
		query.Set("group", group)
		query.Set("tenant", namespace)
	}

	data, err := c.getJSON(baseURL, path, query, accessToken, version)
	if err != nil {
		return ConfigPage{}, err
	}
	page := ConfigPage{
		TotalCount:     i(asObject(data), "totalCount"),
		PageNumber:     i(asObject(data), "pageNumber"),
		PagesAvailable: i(asObject(data), "pagesAvailable"),
		PageItems:      []ConfigItem{},
	}
	for _, item := range asArray(asObject(data)["pageItems"]) {
		c := asObject(item)
		page.PageItems = append(page.PageItems, ConfigItem{
			DataId:     s(c, "dataId"),
			Group:      sAny(c, "group", "groupName"),
			Content:    s(c, "content"),
			ConfigType: s(c, "type"),
		})
	}
	return page, nil
}

// GetConfig 获取指定配置内容。
//
// v1 直接返回纯文本内容，v3 返回 JSON 信封并把内容放在 data.content。
func (c *Client) GetConfig(baseURL, accessToken, apiVersion, namespace, dataID, group string) (string, error) {
	version := parseAPI(apiVersion)
	query := url.Values{}
	query.Set("dataId", dataID)
	if version == apiV3 {
		query.Set("groupName", group)
		query.Set("namespaceId", namespace)
		data, err := c.getJSON(baseURL, "/v3/console/cs/config", query, accessToken, version)
		if err != nil {
			return "", err
		}
		return s(asObject(data), "content"), nil
	}
	query.Set("group", group)
	query.Set("tenant", namespace)
	return c.getText(baseURL, "/v1/cs/configs", query, accessToken, version)
}

// HistoryList 分页查询指定配置的历史版本。
func (c *Client) HistoryList(baseURL, accessToken, apiVersion, namespace, dataID, group string, pageNo, pageSize int64) (HistoryPage, error) {
	version := parseAPI(apiVersion)
	query := url.Values{}
	query.Set("dataId", dataID)
	query.Set("pageNo", strconv.FormatInt(pageNo, 10))
	query.Set("pageSize", strconv.FormatInt(pageSize, 10))

	path := "/v1/cs/history"
	if version == apiV3 {
		path = "/v3/console/cs/history/list"
		query.Set("groupName", group)
		query.Set("namespaceId", namespace)
	} else {
		query.Set("search", "accurate")
		query.Set("group", group)
		query.Set("tenant", namespace)
	}

	data, err := c.getJSON(baseURL, path, query, accessToken, version)
	if err != nil {
		return HistoryPage{}, err
	}
	page := HistoryPage{
		TotalCount:     i(asObject(data), "totalCount"),
		PageNumber:     i(asObject(data), "pageNumber"),
		PagesAvailable: i(asObject(data), "pagesAvailable"),
		PageItems:      []HistoryItem{},
	}
	for _, item := range asArray(asObject(data)["pageItems"]) {
		h := asObject(item)
		page.PageItems = append(page.PageItems, HistoryItem{
			Id:               s(h, "id"),
			DataId:           s(h, "dataId"),
			Group:            sAny(h, "group", "groupName"),
			OpType:           s(h, "opType"),
			LastModifiedTime: sAny(h, "lastModifiedTime", "modifyTime"),
		})
	}
	return page, nil
}

// HistoryDetail 获取指定历史版本详情。
func (c *Client) HistoryDetail(baseURL, accessToken, apiVersion, namespace, dataID, group, nid string) (HistoryDetail, error) {
	version := parseAPI(apiVersion)
	query := url.Values{}
	query.Set("dataId", dataID)
	query.Set("nid", nid)

	path := "/v1/cs/history"
	if version == apiV3 {
		path = "/v3/console/cs/history"
		query.Set("groupName", group)
		query.Set("namespaceId", namespace)
	} else {
		query.Set("group", group)
		query.Set("tenant", namespace)
	}

	data, err := c.getJSON(baseURL, path, query, accessToken, version)
	if err != nil {
		return HistoryDetail{}, err
	}
	h := asObject(data)
	return HistoryDetail{
		Id:               s(h, "id"),
		DataId:           s(h, "dataId"),
		Group:            sAny(h, "group", "groupName"),
		Content:          s(h, "content"),
		OpType:           s(h, "opType"),
		CreatedTime:      sAny(h, "createdTime", "createTime"),
		LastModifiedTime: sAny(h, "lastModifiedTime", "modifyTime"),
	}, nil
}

// PublishConfig 发布或更新配置。
//
// v1 成功时返回文本 true，v3 成功时返回 {code:0,data:true}。
func (c *Client) PublishConfig(baseURL, accessToken, apiVersion, namespace, dataID, group, content, configType string) error {
	version := parseAPI(apiVersion)
	form := url.Values{}
	form.Set("dataId", dataID)
	form.Set("content", content)
	form.Set("type", configType)

	path := "/v1/cs/configs"
	if version == apiV3 {
		path = "/v3/console/cs/config"
		form.Set("groupName", group)
		form.Set("namespaceId", namespace)
	} else {
		form.Set("group", group)
		form.Set("tenant", namespace)
	}

	text, err := c.sendForm(http.MethodPost, baseURL, path, url.Values{}, form, accessToken, version)
	if err != nil {
		return err
	}
	if version == apiV1 {
		if strings.TrimSpace(text) != "true" {
			return fmt.Errorf("发布失败: %s", truncate(text))
		}
		return nil
	}
	v, err := decodeJSON(text)
	if err != nil {
		return fmt.Errorf("解析响应失败: %w —— %s", err, truncate(text))
	}
	if i(v, "code") != 0 || v["data"] != true {
		return fmt.Errorf("发布失败: %s", s(v, "message"))
	}
	return nil
}

// DeleteConfig 删除指定配置。
//
// v1 成功时返回文本 true，v3 成功时返回 code 为 0 的 JSON 信封。
func (c *Client) DeleteConfig(baseURL, accessToken, apiVersion, namespace, dataID, group string) error {
	version := parseAPI(apiVersion)
	query := url.Values{}
	query.Set("dataId", dataID)

	path := "/v1/cs/configs"
	if version == apiV3 {
		path = "/v3/console/cs/config"
		query.Set("groupName", group)
		query.Set("namespaceId", namespace)
	} else {
		query.Set("group", group)
		query.Set("tenant", namespace)
	}

	text, err := c.sendForm(http.MethodDelete, baseURL, path, query, nil, accessToken, version)
	if err != nil {
		return err
	}
	if version == apiV1 {
		if strings.TrimSpace(text) != "true" {
			return fmt.Errorf("删除失败: %s", truncate(text))
		}
		return nil
	}
	v, err := decodeJSON(text)
	if err != nil {
		return fmt.Errorf("解析响应失败: %w —— %s", err, truncate(text))
	}
	if i(v, "code") != 0 {
		return fmt.Errorf("删除失败: %s", s(v, "message"))
	}
	return nil
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

package nacos

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/net/html/charset"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

func base(baseURL string) string {
	return strings.TrimRight(baseURL, "/")
}

// requestPath 给错误文案用（界面、操作历史、用户手抄），不是给请求用。
// 所以查询串必须先过 sanitizeQuery：Nacos v1 的 accessToken 就挂在查询串里，
// 直接把 RawQuery 抄进错误文案，等于把会话令牌写进会被复制粘贴走的文本（轮101）。
func requestPath(req *http.Request) string {
	if req == nil || req.URL == nil {
		return ""
	}
	if req.URL.RawQuery == "" {
		return req.URL.Path
	}
	return req.URL.Path + "?" + sanitizeQuery(req.URL.RawQuery)
}

// sensitiveQueryKey 判断查询参数名是不是带着凭据的那一类。
// 口径宁严勿松：命中不了只是少一条线索，命中漏了就是泄露。
func sensitiveQueryKey(key string) bool {
	lowered := strings.ToLower(strings.TrimSpace(key))
	if lowered == "" {
		return false
	}
	switch lowered {
	case "accesstoken", "accesskey", "accesskeyid", "secretkey", "securitytoken", "password", "username", "token":
		return true
	}
	return strings.Contains(lowered, "token") ||
		strings.Contains(lowered, "password") ||
		strings.Contains(lowered, "secret")
}

// sanitizeQuery 把查询串里的凭据类参数值换成 ***，其余一个字节都不动。
//
// 只做值替换、不做重新编码：这里拼出来的是给人看的文本，
// ParseQuery + Encode 会把别的参数重排并二次转义（* 变 %2A、中文变一长串百分号），
// 用户抄给别人时那些噪音反而挡在中间。空查询串照原样返回空。
func sanitizeQuery(raw string) string {
	if raw == "" {
		return ""
	}
	pairs := strings.Split(raw, "&")
	for i, pair := range pairs {
		key, _, _ := strings.Cut(pair, "=")
		if sensitiveQueryKey(key) {
			pairs[i] = key + "=***"
		}
	}
	return strings.Join(pairs, "&")
}

func requestURL(baseURL, path string, query url.Values) string {
	reqURL := base(baseURL) + path
	if encoded := query.Encode(); encoded != "" {
		reqURL += "?" + encoded
	}
	return reqURL
}

func setNonEmpty(values url.Values, key string, value string) {
	if value != "" {
		values.Set(key, value)
	}
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
		if err := c.applyMSEAuth(req, requestNamespace(query, nil), requestGroup(query, nil)); err != nil {
			return "", err, 0
		}
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
		return "", c.statusError(resp.StatusCode, req, text), resp.StatusCode
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
		if err := c.applyMSEAuth(req, requestNamespace(query, form), requestGroup(query, form)); err != nil {
			return "", err, 0
		}
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
		return "", c.statusError(resp.StatusCode, req, text), resp.StatusCode
	}
	return "", fmt.Errorf("请求失败"), 404
}

// statusError 把非 2xx 响应转成错误。出口只有三条，且必须按这个顺序判（轮101）：
//  1. 报文在要 AccessKey  -> ErrAccessKeyRejected（轮65）；
//  2. 报文在说「身份有、权限没有」 -> ErrConfigPermissionDenied；
//  3. 都不像 -> 状态码 + 请求路径 + 服务端原文，一个字不改地交给用户。
//
// 第 401 也进前两条：以前只认 403，但 MSE 侧对签名与授权的拒绝并不总用 403 表态，
// 落到第 3 条就是一坨排障用的 JSON。第 3 条仍是唯一拼装原文的地方（守卫钉着），
// 分类只认字形，认不出来绝不猜。
func (c *Client) statusError(statusCode int, req *http.Request, body string) error {
	if statusCode == http.StatusForbidden || statusCode == http.StatusUnauthorized {
		if asksForAccessKey(body) {
			return fmt.Errorf("%w: %s（请求 %s）", ErrAccessKeyRejected, c.accessKeyAdvice(), requestPath(req))
		}
		if isPermissionShape(body) {
			return fmt.Errorf("%w: %s（请求 %s）", ErrConfigPermissionDenied, permissionAdvice(req.Method), requestPath(req))
		}
	}
	return fmt.Errorf("Nacos 返回 %d，请求 %s: %s", statusCode, requestPath(req), truncate(body))
}

func readBody(resp *http.Response) (string, error) {
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	return decodeResponseBody(body, resp.Header.Get("Content-Type"))
}

func decodeResponseBody(body []byte, contentType string) (string, error) {
	if len(body) == 0 {
		return "", nil
	}
	if label := responseCharset(contentType); label != "" {
		reader, err := charset.NewReaderLabel(label, bytes.NewReader(body))
		if err != nil {
			return "", fmt.Errorf("无法按响应声明的编码 %q 解码响应体: %w", label, err)
		}
		decoded, err := io.ReadAll(reader)
		if err != nil {
			return "", err
		}
		return string(decoded), nil
	}
	if utf8.Valid(body) {
		return string(body), nil
	}

	decoded, _, err := transform.Bytes(simplifiedchinese.GB18030.NewDecoder(), body)
	if err != nil {
		return "", fmt.Errorf("响应体既不是 UTF-8 也无法按 GB18030 解码: %w", err)
	}
	return string(decoded), nil
}

func responseCharset(contentType string) string {
	if contentType == "" {
		return ""
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(params["charset"])
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

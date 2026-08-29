package nacos

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

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
		setNonEmpty(query, "namespaceId", namespace)
	} else {
		query.Set("group", group)
		setNonEmpty(query, "tenant", namespace)
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
			DataId:           s(c, "dataId"),
			Group:            sAny(c, "group", "groupName"),
			Content:          s(c, "content"),
			Type:             s(c, "type"),
			ConfigType:       sAny(c, "type", "configType"),
			LastModifiedTime: s(c, "lastModifiedTime"),
			Md5:              sAny(c, "md5", "dataMd5"),
		})
	}
	return page, nil
}

// GetConfig 获取指定配置内容与内容摘要。
//
// v1 的 /v1/cs/configs 只返回纯文本，md5 通过额外的列表查询获取（查询失败时 md5 为空）；
// v3 的 JSON 信封自带 md5 字段。
func (c *Client) GetConfig(baseURL, accessToken, apiVersion, namespace, dataID, group string) (ConfigContent, error) {
	version := parseAPI(apiVersion)
	query := url.Values{}
	query.Set("dataId", dataID)
	if version == apiV3 {
		query.Set("groupName", group)
		setNonEmpty(query, "namespaceId", namespace)
		data, err := c.getJSON(baseURL, "/v3/console/cs/config", query, accessToken, version)
		if err != nil {
			return ConfigContent{}, err
		}
		obj := asObject(data)
		return ConfigContent{
			Content: s(obj, "content"),
			Md5:     sAny(obj, "md5", "dataMd5"),
		}, nil
	}
	query.Set("group", group)
	setNonEmpty(query, "tenant", namespace)
	content, err := c.getText(baseURL, "/v1/cs/configs", query, accessToken, version)
	if err != nil {
		return ConfigContent{}, err
	}
	md5, _ := c.queryConfigMd5(baseURL, accessToken, version, namespace, dataID, group)
	return ConfigContent{Content: content, Md5: md5}, nil
}

// queryConfigMd5 通过 v1 列表接口查单条配置的 md5（best-effort，带与 getText 一致的重试）。
func (c *Client) queryConfigMd5(baseURL, accessToken string, version apiVersion, namespace, dataID, group string) (string, error) {
	var lastErr error
	for retry := 0; retry < maxRetries; retry++ {
		if retry > 0 {
			time.Sleep(retryBackoff(retry - 1))
		}
		md5, err, statusCode := c.queryConfigMd5Once(baseURL, accessToken, version, namespace, dataID, group)
		if err == nil {
			return md5, nil
		}
		if !isRetryable(err, statusCode) {
			return "", err
		}
		lastErr = err
	}
	return "", lastErr
}

func (c *Client) queryConfigMd5Once(baseURL, accessToken string, version apiVersion, namespace, dataID, group string) (string, error, int) {
	query := url.Values{}
	query.Set("search", "blur")
	query.Set("dataId", dataID)
	query.Set("group", group)
	query.Set("pageNo", "1")
	query.Set("pageSize", "10")
	setNonEmpty(query, "tenant", namespace)
	data, err := c.getJSON(baseURL, "/v1/cs/configs", query, accessToken, version)
	if err != nil {
		return "", err, 0
	}
	items := asArray(asObject(data)["pageItems"])
	for _, item := range items {
		itemObj := asObject(item)
		if s(itemObj, "dataId") == dataID && (sAny(itemObj, "group", "groupName") == group || sAny(itemObj, "group", "groupName") == "") {
			return sAny(itemObj, "md5", "dataMd5"), nil, 0
		}
	}
	return "", nil, 0
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
		setNonEmpty(form, "namespaceId", namespace)
	} else {
		form.Set("group", group)
		setNonEmpty(form, "tenant", namespace)
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
		setNonEmpty(query, "namespaceId", namespace)
	} else {
		query.Set("group", group)
		setNonEmpty(query, "tenant", namespace)
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

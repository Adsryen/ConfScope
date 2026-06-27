package nacos

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
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

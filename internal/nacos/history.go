package nacos

import (
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
)

// historyFormatFromExtInfo 从历史行的 extInfo 里取该版本自己的配置格式。
//
// 真实 Nacos 2.5.2 把发布时的 type 存进 extInfo（实测 `{"type":"yaml"}`）。
// 取不到就返回空串，由调用方回退到当前配置的格式——历史行的正文渲染不该被
// 服务端没给这个字段拖成报错。
func historyFormatFromExtInfo(extInfo string) string {
	extInfo = strings.TrimSpace(extInfo)
	if extInfo == "" {
		return ""
	}
	var parsed struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal([]byte(extInfo), &parsed); err != nil {
		return ""
	}
	return strings.TrimSpace(parsed.Type)
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
		setNonEmpty(query, "namespaceId", namespace)
	} else {
		query.Set("search", "accurate")
		query.Set("group", group)
		setNonEmpty(query, "tenant", namespace)
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
			OpType:           sTrim(h, "opType"),
			LastModifiedTime: sAny(h, "lastModifiedTime", "modifyTime"),
			SrcIP:            sTrim(h, "srcIp"),
			SrcUser:          sTrim(h, "srcUser"),
			Format:           historyFormatFromExtInfo(s(h, "extInfo")),
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
		setNonEmpty(query, "namespaceId", namespace)
	} else {
		query.Set("group", group)
		setNonEmpty(query, "tenant", namespace)
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
		OpType:           sTrim(h, "opType"),
		CreatedTime:      sAny(h, "createdTime", "createTime"),
		LastModifiedTime: sAny(h, "lastModifiedTime", "modifyTime"),
		SrcIP:            sTrim(h, "srcIp"),
		SrcUser:          sTrim(h, "srcUser"),
		Md5:              sTrim(h, "md5"),
		Format:           historyFormatFromExtInfo(s(h, "extInfo")),
	}, nil
}

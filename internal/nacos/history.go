package nacos

import (
	"net/url"
	"strconv"
)

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

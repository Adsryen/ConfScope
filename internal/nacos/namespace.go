package nacos

import (
	"fmt"
	"net/url"
)

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

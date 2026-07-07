// Package apollo 封装 Apollo OpenAPI 只读访问逻辑。
package apollo

// Namespace 是 Apollo OpenAPI namespace 返回值。
type Namespace struct {
	AppID         string `json:"appId"`
	ClusterName   string `json:"clusterName"`
	NamespaceName string `json:"namespaceName"`
	Format        string `json:"format"`
	ReleaseKey    string `json:"releaseKey"`
	Items         []Item `json:"items"`
}

// Item 是 Apollo namespace 内的单个 key/value 配置项。
type Item struct {
	Key                        string `json:"key"`
	Value                      string `json:"value"`
	Comment                    string `json:"comment"`
	DataChangeLastModifiedTime string `json:"dataChangeLastModifiedTime"`
}

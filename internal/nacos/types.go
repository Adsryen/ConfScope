package nacos

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

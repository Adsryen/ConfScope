package provider

type ProviderType string

const (
	ProviderNacos  ProviderType = "nacos"
	ProviderApollo ProviderType = "apollo"
	ProviderConsul ProviderType = "consul"
	ProviderLocal  ProviderType = "local"
)

type ConnectionProfile struct {
	ID          string       `json:"id"`
	Name        string       `json:"name"`
	Provider    ProviderType `json:"provider"`
	BaseURL     string       `json:"baseUrl"`
	AccessToken string       `json:"accessToken"`
	APIVersion  string       `json:"apiVersion"`
	Environment string       `json:"environment"`
	SafetyLevel string       `json:"safetyLevel"`
}

type ConfigRef struct {
	Provider     ProviderType `json:"provider"`
	ConnectionID string       `json:"connectionId"`
	Namespace    string       `json:"namespace"`
	Group        string       `json:"group"`
	DataID       string       `json:"dataId"`
	Key          string       `json:"key"`
}

type Namespace struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	ConfigCount int64  `json:"configCount"`
	Kind        int64  `json:"kind"`
}

type PageRequest struct {
	PageNo   int64 `json:"pageNo"`
	PageSize int64 `json:"pageSize"`
}

type ListConfigsRequest struct {
	Namespace string `json:"namespace"`
	Group     string `json:"group"`
	DataID    string `json:"dataId"`
	PageNo    int64  `json:"pageNo"`
	PageSize  int64  `json:"pageSize"`
}

type ConfigSummary struct {
	Ref     ConfigRef `json:"ref"`
	Content string    `json:"content"`
	Format  string    `json:"format"`
}

type ConfigPage struct {
	TotalCount     int64           `json:"totalCount"`
	PageNumber     int64           `json:"pageNumber"`
	PagesAvailable int64           `json:"pagesAvailable"`
	PageItems      []ConfigSummary `json:"pageItems"`
}

type ConfigDocument struct {
	Ref     ConfigRef `json:"ref"`
	Content string    `json:"content"`
	Format  string    `json:"format"`
	Version string    `json:"version"`
	Source  string    `json:"source"`
}

type PublishConfigRequest struct {
	Ref     ConfigRef `json:"ref"`
	Content string    `json:"content"`
	Format  string    `json:"format"`
}

type HistoryItem struct {
	ID               string    `json:"id"`
	Ref              ConfigRef `json:"ref"`
	OpType           string    `json:"opType"`
	LastModifiedTime string    `json:"lastModifiedTime"`
}

type HistoryPage struct {
	TotalCount     int64         `json:"totalCount"`
	PageNumber     int64         `json:"pageNumber"`
	PagesAvailable int64         `json:"pagesAvailable"`
	PageItems      []HistoryItem `json:"pageItems"`
}

type HistoryDetail struct {
	ID               string    `json:"id"`
	Ref              ConfigRef `json:"ref"`
	Content          string    `json:"content"`
	OpType           string    `json:"opType"`
	CreatedTime      string    `json:"createdTime"`
	LastModifiedTime string    `json:"lastModifiedTime"`
}

type ConfigProvider interface {
	ListNamespaces(profile ConnectionProfile) ([]Namespace, error)
	ListConfigs(profile ConnectionProfile, req ListConfigsRequest) (ConfigPage, error)
	GetConfig(profile ConnectionProfile, ref ConfigRef) (ConfigDocument, error)
	PublishConfig(profile ConnectionProfile, req PublishConfigRequest) error
	DeleteConfig(profile ConnectionProfile, ref ConfigRef) error
	ListHistory(profile ConnectionProfile, ref ConfigRef, page PageRequest) (HistoryPage, error)
	GetHistoryDetail(profile ConnectionProfile, ref ConfigRef, id string) (HistoryDetail, error)
	TestConnection(profile ConnectionProfile) error
}

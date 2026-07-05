package provider

type ProviderType string
type Distribution string
type AuthType string

const (
	ProviderNacos  ProviderType = "nacos"
	ProviderApollo ProviderType = "apollo"
	ProviderConsul ProviderType = "consul"
	ProviderLocal  ProviderType = "local"
)

const (
	DistributionOpenSource Distribution = "opensource"
	DistributionAliyunMSE  Distribution = "aliyun-mse"
)

const (
	AuthNone          AuthType = "none"
	AuthNacosPassword AuthType = "nacos-password"
	AuthAliyunAKSK    AuthType = "aliyun-aksk"
)

type ConnectionProfile struct {
	ID              string       `json:"id"`
	Name            string       `json:"name"`
	Provider        ProviderType `json:"provider"`
	Distribution    Distribution `json:"distribution"`
	AuthType        AuthType     `json:"authType"`
	BaseURL         string       `json:"baseUrl"`
	AccessToken     string       `json:"accessToken"`
	APIVersion      string       `json:"apiVersion"`
	AccessKeyID     string       `json:"accessKeyId"`
	AccessKeySecret string       `json:"accessKeySecret"`
	SecurityToken   string       `json:"securityToken"`
	Environment     string       `json:"environment"`
	SafetyLevel     string       `json:"safetyLevel"`
	UseProxy        bool         `json:"useProxy"`
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
	Ref        ConfigRef `json:"ref"`
	Content    string    `json:"content"`
	Format     string    `json:"format"`
	UpdateTime string    `json:"updateTime"`
}

type ConfigPage struct {
	TotalCount     int64           `json:"totalCount"`
	PageNumber     int64           `json:"pageNumber"`
	PagesAvailable int64           `json:"pagesAvailable"`
	PageItems      []ConfigSummary `json:"pageItems"`
}

type ConfigDocument struct {
	Ref        ConfigRef `json:"ref"`
	Content    string    `json:"content"`
	Format     string    `json:"format"`
	Version    string    `json:"version"`
	Source     string    `json:"source"`
	UpdateTime string    `json:"updateTime"`
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

// ── 快照相关类型 ──

// SnapshotSource 快照来源。
type SnapshotSource struct {
	Provider       ProviderType `json:"provider"`
	ConnectionID   string       `json:"connectionId"`
	ConnectionName string       `json:"connectionName"`
	Namespace      string       `json:"namespace"`
	NamespaceID    string       `json:"namespaceId"`
}

// ConfigSnapshot 配置快照。
type ConfigSnapshot struct {
	Namespace   string `json:"namespace"`
	DataID      string `json:"dataId"`
	Group       string `json:"group"`
	ContentType string `json:"contentType"`
	Content     string `json:"content"`
	ConfigType  string `json:"configType"`
	UpdateTime  string `json:"updateTime"`
}

// Snapshot 快照。
type Snapshot struct {
	SchemaVersion int              `json:"schemaVersion"`
	ToolVersion   string           `json:"toolVersion"`
	ID            string           `json:"id"`
	Path          string           `json:"path"`
	Name          string           `json:"name"`
	Description   string           `json:"description"`
	CreatedAt     string           `json:"createdAt"`
	UpdatedAt     string           `json:"updatedAt"`
	Source        SnapshotSource   `json:"source"`
	Configs       []ConfigSnapshot `json:"configs"`
}

// LocalSnapshotValidation 是本地快照目录校验结果。
type LocalSnapshotValidation struct {
	Valid          bool     `json:"valid"`
	Path           string   `json:"path"`
	Code           string   `json:"code"`
	Message        string   `json:"message"`
	ConfigCount    int      `json:"configCount"`
	HasManifest    bool     `json:"hasManifest"`
	MatchedMarkers []string `json:"matchedMarkers"`
	SchemaVersion  int      `json:"schemaVersion"`
	Layout         string   `json:"layout"`
	Legacy         bool     `json:"legacy"`
	CheckedAt      string   `json:"checkedAt"`
}

// SnapshotManager 快照管理器接口。
type SnapshotManager interface {
	CreateSnapshot(source SnapshotSource, configs []ConfigSnapshot) (*Snapshot, error)
	GetSnapshot(id string) (*Snapshot, error)
	ListSnapshots() ([]Snapshot, error)
	DeleteSnapshot(id string) error
	ValidateSnapshot(path string) error
}

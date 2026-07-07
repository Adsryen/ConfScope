package provider

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"confscope/internal/apollo"
)

var errApolloReadOnly = errors.New("Apollo 配置中心当前为只读模式")

// ApolloProvider 实现 Apollo OpenAPI 只读配置中心适配。
type ApolloProvider struct {
	client *apollo.Client
}

// NewApolloProvider 创建 Apollo 只读配置中心 provider。
func NewApolloProvider(client *apollo.Client) *ApolloProvider {
	if client == nil {
		client = apollo.NewClient()
	}
	return &ApolloProvider{client: client}
}

func (p *ApolloProvider) ListNamespaces(profile ConnectionProfile) ([]Namespace, error) {
	target, err := apolloTargetFromProfile(profile)
	if err != nil {
		return nil, err
	}
	items, err := p.clientFor(profile).ListNamespaces(profile.BaseURL, profile.AccessToken, target.env, target.appID, target.cluster)
	if err != nil {
		if target.namespaceName != "" {
			return []Namespace{apolloProviderNamespace(target, 1)}, nil
		}
		return nil, err
	}
	return []Namespace{apolloProviderNamespace(target, int64(len(items)))}, nil
}

func (p *ApolloProvider) ListConfigs(profile ConnectionProfile, req ListConfigsRequest) (ConfigPage, error) {
	target, err := apolloTargetFromRequest(profile, ConfigRef{Namespace: req.Namespace, Group: req.Group, DataID: req.DataID}, false)
	if err != nil {
		return ConfigPage{}, err
	}
	filterName := strings.TrimSpace(req.DataID)

	namespaces, err := p.clientFor(profile).ListNamespaces(profile.BaseURL, profile.AccessToken, target.env, target.appID, target.cluster)
	if err != nil {
		fallbackName := firstNonBlank(req.DataID, profile.ApolloNamespaceName)
		if fallbackName == "" {
			return ConfigPage{}, err
		}
		namespaces = []apollo.Namespace{{AppID: target.appID, ClusterName: target.cluster, NamespaceName: fallbackName, Format: "properties", Items: []apollo.Item{}}}
	}

	filtered := make([]apollo.Namespace, 0, len(namespaces))
	for _, item := range namespaces {
		if matchesApolloNamespaceFilter(item.NamespaceName, filterName) {
			filtered = append(filtered, item)
		}
	}
	sort.Slice(filtered, func(i, j int) bool {
		return filtered[i].NamespaceName < filtered[j].NamespaceName
	})

	pageNo := req.PageNo
	if pageNo <= 0 {
		pageNo = 1
	}
	pageSize := req.PageSize
	if pageSize <= 0 {
		pageSize = int64(len(filtered))
	}
	start := int((pageNo - 1) * pageSize)
	if start > len(filtered) {
		start = len(filtered)
	}
	end := start + int(pageSize)
	if end > len(filtered) {
		end = len(filtered)
	}

	items := make([]ConfigSummary, 0, end-start)
	for _, namespace := range filtered[start:end] {
		items = append(items, ConfigSummary{
			Ref: ConfigRef{
				Provider:     ProviderApollo,
				ConnectionID: profile.ID,
				Namespace:    target.appID,
				Group:        target.cluster,
				DataID:       namespace.NamespaceName,
			},
			Content:    serializeApolloItems(namespace.Items),
			Format:     apolloFormat(namespace),
			UpdateTime: latestApolloUpdateTime(namespace.Items),
		})
	}

	pages := int64(0)
	if len(filtered) > 0 && pageSize > 0 {
		pages = (int64(len(filtered)) + pageSize - 1) / pageSize
	}
	return ConfigPage{
		TotalCount:     int64(len(filtered)),
		PageNumber:     pageNo,
		PagesAvailable: pages,
		PageItems:      items,
	}, nil
}

func (p *ApolloProvider) GetConfig(profile ConnectionProfile, ref ConfigRef) (ConfigDocument, error) {
	target, err := apolloTargetFromRequest(profile, ref, true)
	if err != nil {
		return ConfigDocument{}, err
	}
	namespace, err := p.clientFor(profile).GetNamespace(profile.BaseURL, profile.AccessToken, target.env, target.appID, target.cluster, target.namespaceName)
	if err != nil {
		return ConfigDocument{}, err
	}
	normalizedRef := ConfigRef{
		Provider:     ProviderApollo,
		ConnectionID: profile.ID,
		Namespace:    target.appID,
		Group:        target.cluster,
		DataID:       target.namespaceName,
		Key:          "",
	}
	return ConfigDocument{
		Ref:        normalizedRef,
		Content:    serializeApolloItems(namespace.Items),
		Format:     apolloFormat(namespace),
		Version:    namespace.ReleaseKey,
		Source:     fmt.Sprintf("apollo:%s/%s/%s/%s", target.env, target.appID, target.cluster, target.namespaceName),
		UpdateTime: latestApolloUpdateTime(namespace.Items),
	}, nil
}

func (p *ApolloProvider) PublishConfig(profile ConnectionProfile, req PublishConfigRequest) error {
	return errApolloReadOnly
}

func (p *ApolloProvider) DeleteConfig(profile ConnectionProfile, ref ConfigRef) error {
	return errApolloReadOnly
}

func (p *ApolloProvider) ListHistory(profile ConnectionProfile, ref ConfigRef, page PageRequest) (HistoryPage, error) {
	return HistoryPage{}, errApolloReadOnly
}

func (p *ApolloProvider) GetHistoryDetail(profile ConnectionProfile, ref ConfigRef, id string) (HistoryDetail, error) {
	return HistoryDetail{}, errApolloReadOnly
}

func (p *ApolloProvider) TestConnection(profile ConnectionProfile) error {
	target, err := apolloTargetFromProfile(profile)
	if err != nil {
		return err
	}
	if target.namespaceName == "" {
		return errors.New("Apollo namespaceName is required")
	}
	_, err = p.clientFor(profile).GetNamespace(profile.BaseURL, profile.AccessToken, target.env, target.appID, target.cluster, target.namespaceName)
	return err
}

func (p *ApolloProvider) clientFor(profile ConnectionProfile) *apollo.Client {
	if profile.UseProxy {
		return apollo.NewClientWithProxy()
	}
	return p.client
}

type apolloTarget struct {
	env           string
	appID         string
	cluster       string
	namespaceName string
}

func apolloTargetFromProfile(profile ConnectionProfile) (apolloTarget, error) {
	return apolloTargetFromRequest(profile, ConfigRef{}, false)
}

func apolloTargetFromRequest(profile ConnectionProfile, ref ConfigRef, requireNamespaceName bool) (apolloTarget, error) {
	target := apolloTarget{
		env:           firstNonBlank(profile.ApolloEnv, profile.Environment, "DEV"),
		appID:         firstNonBlank(ref.Namespace, profile.ApolloAppID),
		cluster:       firstNonBlank(ref.Group, profile.ApolloCluster, "default"),
		namespaceName: firstNonBlank(ref.DataID, profile.ApolloNamespaceName),
	}
	if target.appID == "" {
		return apolloTarget{}, errors.New("Apollo appId is required")
	}
	if requireNamespaceName && target.namespaceName == "" {
		return apolloTarget{}, errors.New("Apollo namespaceName is required")
	}
	return target, nil
}

func apolloProviderNamespace(target apolloTarget, count int64) Namespace {
	return Namespace{
		ID:          target.appID,
		Name:        fmt.Sprintf("%s / %s / %s", target.appID, target.env, target.cluster),
		ConfigCount: count,
	}
}

func matchesApolloNamespaceFilter(namespaceName string, filter string) bool {
	filter = strings.TrimSpace(filter)
	if filter == "" {
		return true
	}
	if strings.Contains(filter, "*") {
		needle := strings.Trim(filter, "*")
		return needle == "" || strings.Contains(namespaceName, needle)
	}
	return namespaceName == filter
}

func serializeApolloItems(items []apollo.Item) string {
	sorted := append([]apollo.Item(nil), items...)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].Key < sorted[j].Key
	})
	var b strings.Builder
	for _, item := range sorted {
		b.WriteString(item.Key)
		b.WriteString("=")
		b.WriteString(item.Value)
		b.WriteString("\n")
	}
	return b.String()
}

func latestApolloUpdateTime(items []apollo.Item) string {
	latest := ""
	for _, item := range items {
		if item.DataChangeLastModifiedTime > latest {
			latest = item.DataChangeLastModifiedTime
		}
	}
	return latest
}

func apolloFormat(namespace apollo.Namespace) string {
	if strings.TrimSpace(namespace.Format) != "" {
		return strings.ToLower(strings.TrimSpace(namespace.Format))
	}
	if strings.HasSuffix(strings.ToLower(namespace.NamespaceName), ".json") {
		return "json"
	}
	if strings.HasSuffix(strings.ToLower(namespace.NamespaceName), ".yaml") || strings.HasSuffix(strings.ToLower(namespace.NamespaceName), ".yml") {
		return "yaml"
	}
	return "properties"
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

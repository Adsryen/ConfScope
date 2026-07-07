package provider

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"confscope/internal/consul"
)

var errConsulReadOnly = errors.New("Consul KV 当前为只读模式")

// ConsulProvider 实现 Consul KV 只读配置中心适配。
type ConsulProvider struct {
	client *consul.Client
}

// NewConsulProvider 创建 Consul KV 只读配置中心 provider。
func NewConsulProvider(client *consul.Client) *ConsulProvider {
	if client == nil {
		client = consul.NewClient()
	}
	return &ConsulProvider{client: client}
}

func (p *ConsulProvider) ListNamespaces(profile ConnectionProfile) ([]Namespace, error) {
	datacenters, err := p.clientFor(profile).Datacenters(profile.BaseURL, profile.AccessToken)
	if err != nil {
		if strings.TrimSpace(profile.ConsulDatacenter) != "" {
			dc := strings.TrimSpace(profile.ConsulDatacenter)
			return []Namespace{{ID: dc, Name: dc}}, nil
		}
		return nil, err
	}
	out := make([]Namespace, 0, len(datacenters))
	for _, dc := range datacenters {
		dc = strings.TrimSpace(dc)
		if dc == "" {
			continue
		}
		out = append(out, Namespace{ID: dc, Name: dc})
	}
	return out, nil
}

func (p *ConsulProvider) ListConfigs(profile ConnectionProfile, req ListConfigsRequest) (ConfigPage, error) {
	target := consulTargetFromRequest(profile, ConfigRef{Namespace: req.Namespace, Group: req.Group, DataID: req.DataID}, false)
	pairs, err := p.clientFor(profile).ListKV(profile.BaseURL, profile.AccessToken, target.datacenter, target.prefix)
	if err != nil {
		return ConfigPage{}, err
	}

	filter := strings.TrimSpace(req.DataID)
	items := make([]consul.KVPair, 0, len(pairs))
	for _, pair := range pairs {
		if isConsulDirectory(pair, target.prefix) || !matchesConsulKeyFilter(pair.Key, filter) {
			continue
		}
		items = append(items, pair)
	}
	sort.Slice(items, func(i, j int) bool {
		return items[i].Key < items[j].Key
	})

	pageNo := req.PageNo
	if pageNo <= 0 {
		pageNo = 1
	}
	pageSize := req.PageSize
	if pageSize <= 0 {
		pageSize = int64(len(items))
	}
	start := int((pageNo - 1) * pageSize)
	if start > len(items) {
		start = len(items)
	}
	end := start + int(pageSize)
	if end > len(items) {
		end = len(items)
	}

	summaries := make([]ConfigSummary, 0, end-start)
	for _, pair := range items[start:end] {
		content, err := consul.DecodeValue(pair)
		if err != nil {
			return ConfigPage{}, err
		}
		summaries = append(summaries, ConfigSummary{
			Ref:        consulRef(profile, target.datacenter, target.prefix, pair.Key),
			Content:    content,
			Format:     consulFormat(pair.Key, content),
			UpdateTime: consulVersion(pair),
		})
	}

	pages := int64(0)
	if len(items) > 0 && pageSize > 0 {
		pages = (int64(len(items)) + pageSize - 1) / pageSize
	}
	return ConfigPage{
		TotalCount:     int64(len(items)),
		PageNumber:     pageNo,
		PagesAvailable: pages,
		PageItems:      summaries,
	}, nil
}

func (p *ConsulProvider) GetConfig(profile ConnectionProfile, ref ConfigRef) (ConfigDocument, error) {
	target := consulTargetFromRequest(profile, ref, true)
	if target.key == "" {
		return ConfigDocument{}, errors.New("Consul key is required")
	}
	pair, err := p.clientFor(profile).GetKV(profile.BaseURL, profile.AccessToken, target.datacenter, target.key)
	if err != nil {
		return ConfigDocument{}, err
	}
	content, err := consul.DecodeValue(pair)
	if err != nil {
		return ConfigDocument{}, err
	}
	normalizedRef := consulRef(profile, target.datacenter, target.prefix, pair.Key)
	return ConfigDocument{
		Ref:        normalizedRef,
		Content:    content,
		Format:     consulFormat(pair.Key, content),
		Version:    consulVersion(pair),
		Source:     fmt.Sprintf("consul:%s/%s", target.datacenter, pair.Key),
		UpdateTime: consulVersion(pair),
	}, nil
}

func (p *ConsulProvider) PublishConfig(profile ConnectionProfile, req PublishConfigRequest) error {
	return errConsulReadOnly
}

func (p *ConsulProvider) DeleteConfig(profile ConnectionProfile, ref ConfigRef) error {
	return errConsulReadOnly
}

func (p *ConsulProvider) ListHistory(profile ConnectionProfile, ref ConfigRef, page PageRequest) (HistoryPage, error) {
	return HistoryPage{}, errConsulReadOnly
}

func (p *ConsulProvider) GetHistoryDetail(profile ConnectionProfile, ref ConfigRef, id string) (HistoryDetail, error) {
	return HistoryDetail{}, errConsulReadOnly
}

func (p *ConsulProvider) TestConnection(profile ConnectionProfile) error {
	target := consulTargetFromProfile(profile)
	_, err := p.clientFor(profile).ListKV(profile.BaseURL, profile.AccessToken, target.datacenter, target.prefix)
	return err
}

func (p *ConsulProvider) clientFor(profile ConnectionProfile) *consul.Client {
	if profile.UseProxy {
		return consul.NewClientWithProxy()
	}
	return p.client
}

type consulTarget struct {
	datacenter string
	prefix     string
	key        string
}

func consulTargetFromProfile(profile ConnectionProfile) consulTarget {
	return consulTargetFromRequest(profile, ConfigRef{}, false)
}

func consulTargetFromRequest(profile ConnectionProfile, ref ConfigRef, requireKey bool) consulTarget {
	target := consulTarget{
		datacenter: firstNonBlank(ref.Namespace, profile.ConsulDatacenter),
		prefix:     consulPrefixFromGroup(ref.Group, profile.ConsulKeyPrefix),
		key:        strings.TrimSpace(ref.DataID),
	}
	if requireKey && target.key == "" {
		return target
	}
	return target
}

func consulPrefixFromGroup(group, fallback string) string {
	value := strings.TrimSpace(group)
	if value == "" || value == "DEFAULT_GROUP" {
		return strings.TrimSpace(fallback)
	}
	return value
}

func consulRef(profile ConnectionProfile, datacenter, prefix, key string) ConfigRef {
	return ConfigRef{
		Provider:     ProviderConsul,
		ConnectionID: profile.ID,
		Namespace:    datacenter,
		Group:        prefix,
		DataID:       key,
		Key:          "",
	}
}

func isConsulDirectory(pair consul.KVPair, prefix string) bool {
	key := strings.TrimSpace(pair.Key)
	if key == "" {
		return true
	}
	return key == prefix || strings.HasSuffix(key, "/")
}

func matchesConsulKeyFilter(key string, filter string) bool {
	filter = strings.TrimSpace(filter)
	if filter == "" {
		return true
	}
	if strings.Contains(filter, "*") {
		needle := strings.Trim(filter, "*")
		return needle == "" || strings.Contains(key, needle)
	}
	return strings.Contains(key, filter)
}

func consulVersion(pair consul.KVPair) string {
	if pair.ModifyIndex == 0 {
		return ""
	}
	return strconv.FormatUint(pair.ModifyIndex, 10)
}

func consulFormat(key, content string) string {
	lower := strings.ToLower(strings.TrimSpace(key))
	switch {
	case strings.HasSuffix(lower, ".json"):
		return "json"
	case strings.HasSuffix(lower, ".yaml"), strings.HasSuffix(lower, ".yml"):
		return "yaml"
	case strings.HasSuffix(lower, ".properties"):
		return "properties"
	case strings.HasSuffix(lower, ".xml"):
		return "xml"
	case strings.HasSuffix(lower, ".toml"):
		return "toml"
	}
	text := strings.TrimSpace(content)
	if strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[") {
		return "json"
	}
	return "text"
}

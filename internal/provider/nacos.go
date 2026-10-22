package provider

import (
	"fmt"
	"strings"
	"time"

	"confscope/internal/nacos"
)

type NacosProvider struct {
	client *nacos.Client
}

func NewNacosProvider(client *nacos.Client) *NacosProvider {
	if client == nil {
		client = nacos.NewClient()
	}
	return &NacosProvider{client: client}
}

func (p *NacosProvider) ListNamespaces(profile ConnectionProfile) ([]Namespace, error) {
	client := p.clientFor(profile)
	items, err := client.Namespaces(profile.BaseURL, profile.AccessToken, profile.APIVersion)
	if err != nil {
		return nil, err
	}
	out := make([]Namespace, 0, len(items))
	for _, item := range items {
		out = append(out, Namespace{
			ID:          item.Namespace,
			Name:        item.NamespaceShowName,
			ConfigCount: item.ConfigCount,
			Kind:        item.Kind,
		})
	}
	return out, nil
}

func (p *NacosProvider) ListConfigs(profile ConnectionProfile, req ListConfigsRequest) (ConfigPage, error) {
	client := p.clientFor(profile)
	namespace := normalizeMSERequestNamespace(profile, req.Namespace)
	group := normalizeMSERequestGroup(profile, req.Group)
	page, err := client.ListConfigs(
		profile.BaseURL,
		profile.AccessToken,
		profile.APIVersion,
		namespace,
		req.DataID,
		group,
		req.PageNo,
		req.PageSize,
	)
	if err != nil {
		return ConfigPage{}, err
	}

	out := ConfigPage{
		TotalCount:     page.TotalCount,
		PageNumber:     page.PageNumber,
		PagesAvailable: page.PagesAvailable,
		PageItems:      make([]ConfigSummary, 0, len(page.PageItems)),
	}
	for _, item := range page.PageItems {
		out.PageItems = append(out.PageItems, ConfigSummary{
			Ref: ConfigRef{
				Provider:     ProviderNacos,
				ConnectionID: profile.ID,
				Namespace:    namespace,
				Group:        item.Group,
				DataID:       item.DataId,
			},
			Content:    item.Content,
			Format:     firstNonEmpty(item.Type, item.ConfigType),
			UpdateTime: nacosTimeToString(item.LastModifiedTime),
		})
	}
	return out, nil
}

// firstNonEmpty 返回第一个非空字符串。
func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// nacosTimeToString 把 Nacos 毫秒时间戳字符串转成 "YYYY-MM-DD HH:mm:ss"（本地时区）。
func nacosTimeToString(ms string) string {
	if ms == "" {
		return ""
	}
	var n int64
	if _, err := fmt.Sscanf(ms, "%d", &n); err != nil || n <= 0 {
		return ""
	}
	return time.UnixMilli(n).Format("2006-01-02 15:04:05")
}

func (p *NacosProvider) GetConfig(profile ConnectionProfile, ref ConfigRef) (ConfigDocument, error) {
	client := p.clientFor(profile)
	ref.Namespace = normalizeMSERequestNamespace(profile, ref.Namespace)
	result, err := client.GetConfig(profile.BaseURL, profile.AccessToken, profile.APIVersion, ref.Namespace, ref.DataID, ref.Group)
	if err != nil {
		return ConfigDocument{}, err
	}
	return ConfigDocument{
		Ref:     normalizeRef(profile, ref),
		Content: result.Content,
		Source:  string(ProviderNacos),
		Md5:     result.Md5,
	}, nil
}

func (p *NacosProvider) PublishConfig(profile ConnectionProfile, req PublishConfigRequest) error {
	ref := normalizeRef(profile, req.Ref)
	ref.Namespace = normalizeMSERequestNamespace(profile, ref.Namespace)
	client := p.clientFor(profile)
	return client.PublishConfig(profile.BaseURL, profile.AccessToken, profile.APIVersion, ref.Namespace, ref.DataID, ref.Group, req.Content, req.Format)
}

func (p *NacosProvider) DeleteConfig(profile ConnectionProfile, ref ConfigRef) error {
	ref = normalizeRef(profile, ref)
	ref.Namespace = normalizeMSERequestNamespace(profile, ref.Namespace)
	client := p.clientFor(profile)
	return client.DeleteConfig(profile.BaseURL, profile.AccessToken, profile.APIVersion, ref.Namespace, ref.DataID, ref.Group)
}

func (p *NacosProvider) ListHistory(profile ConnectionProfile, ref ConfigRef, page PageRequest) (HistoryPage, error) {
	ref = normalizeRef(profile, ref)
	ref.Namespace = normalizeMSERequestNamespace(profile, ref.Namespace)
	client := p.clientFor(profile)
	history, err := client.HistoryList(profile.BaseURL, profile.AccessToken, profile.APIVersion, ref.Namespace, ref.DataID, ref.Group, page.PageNo, page.PageSize)
	if err != nil {
		return HistoryPage{}, err
	}
	out := HistoryPage{
		TotalCount:     history.TotalCount,
		PageNumber:     history.PageNumber,
		PagesAvailable: history.PagesAvailable,
		PageItems:      make([]HistoryItem, 0, len(history.PageItems)),
	}
	for _, item := range history.PageItems {
		itemRef := ref
		itemRef.DataID = item.DataId
		itemRef.Group = item.Group
		out.PageItems = append(out.PageItems, HistoryItem{
			ID:               item.Id,
			Ref:              itemRef,
			OpType:           item.OpType,
			LastModifiedTime: item.LastModifiedTime,
			SrcIP:            item.SrcIP,
			SrcUser:          item.SrcUser,
			Format:           item.Format,
		})
	}
	return out, nil
}

func (p *NacosProvider) GetHistoryDetail(profile ConnectionProfile, ref ConfigRef, id string) (HistoryDetail, error) {
	ref = normalizeRef(profile, ref)
	ref.Namespace = normalizeMSERequestNamespace(profile, ref.Namespace)
	client := p.clientFor(profile)
	detail, err := client.HistoryDetail(profile.BaseURL, profile.AccessToken, profile.APIVersion, ref.Namespace, ref.DataID, ref.Group, id)
	if err != nil {
		return HistoryDetail{}, err
	}
	detailRef := ref
	detailRef.DataID = detail.DataId
	detailRef.Group = detail.Group
	return HistoryDetail{
		ID:               detail.Id,
		Ref:              detailRef,
		Content:          detail.Content,
		OpType:           detail.OpType,
		CreatedTime:      detail.CreatedTime,
		LastModifiedTime: detail.LastModifiedTime,
		SrcIP:            detail.SrcIP,
		SrcUser:          detail.SrcUser,
		Md5:              detail.Md5,
		Format:           detail.Format,
	}, nil
}

func (p *NacosProvider) TestConnection(profile ConnectionProfile) error {
	client := p.clientFor(profile)
	if nacosRequestSignRequested(profile) {
		// 要签名的连接（阿里云 MSE）没有开源的 console 命名空间接口，探活只能走配置列表。
		_, err := client.ListConfigs(profile.BaseURL, "", "v1", "", "", "DEFAULT_GROUP", 1, 1)
		return err
	}
	_, err := client.Namespaces(profile.BaseURL, profile.AccessToken, profile.APIVersion)
	return err
}

// nacosRequestSignRequested 是「这个连接的请求要不要带阿里云 MSE（Spas）签名」的唯一判据。
//
// 命中任意一条即签名：
//  1. 连接声明了「阿里云 MSE + AK/SK」。即使凭据还没填也要走签名通路——由 nacos 包在
//     发请求前报 ErrMSEAuthMissing（轮60），不允许静默退化成匿名请求。
//  2. 连接里 AccessKey/SecretKey 都填齐了。服务端要不要签名取决于请求里有没有
//     AccessKey，不取决于用户把哪两个下拉配成了一对（2026-10-22 真机 403
//     "accessKeyId can't be null" 就是这个形态：AK/SK 填了，标记没配）。
//
// namespace/group 的归一、探活走哪个接口、要不要挂签名，必须共用这一个判据：
// 各写一处枚举比较，就会出现「签名的 resource 和实际发出去的参数不是同一个」，
// 那是另一颗更难查的 403。
func nacosRequestSignRequested(profile ConnectionProfile) bool {
	if profile.Distribution == DistributionAliyunMSE && profile.AuthType == AuthAliyunAKSK {
		return true
	}
	return strings.TrimSpace(profile.AccessKeyID) != "" && strings.TrimSpace(profile.AccessKeySecret) != ""
}

func (p *NacosProvider) clientFor(profile ConnectionProfile) *nacos.Client {
	base := p.client
	if profile.UseProxy {
		base = nacos.NewClientWithProxy()
	}
	if !nacosRequestSignRequested(profile) {
		return base
	}
	return base.WithMSEAuth(nacos.MSEAuth{
		AccessKeyID:     strings.TrimSpace(profile.AccessKeyID),
		AccessKeySecret: strings.TrimSpace(profile.AccessKeySecret),
		SecurityToken:   strings.TrimSpace(profile.SecurityToken),
	})
}

func normalizeMSERequestNamespace(profile ConnectionProfile, namespace string) string {
	if nacosRequestSignRequested(profile) && namespace == "public" {
		return ""
	}
	return namespace
}

func normalizeMSERequestGroup(profile ConnectionProfile, group string) string {
	if nacosRequestSignRequested(profile) && group == "" {
		return "DEFAULT_GROUP"
	}
	return group
}

func normalizeRef(profile ConnectionProfile, ref ConfigRef) ConfigRef {
	if ref.Provider == "" {
		ref.Provider = ProviderNacos
	}
	if ref.ConnectionID == "" {
		ref.ConnectionID = profile.ID
	}
	return ref
}

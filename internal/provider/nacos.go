package provider

import "confscope/internal/nacos"

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
	items, err := p.client.Namespaces(profile.BaseURL, profile.AccessToken, profile.APIVersion)
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
	page, err := p.client.ListConfigs(
		profile.BaseURL,
		profile.AccessToken,
		profile.APIVersion,
		req.Namespace,
		req.DataID,
		req.Group,
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
				Namespace:    req.Namespace,
				Group:        item.Group,
				DataID:       item.DataId,
			},
			Content: item.Content,
			Format:  item.ConfigType,
		})
	}
	return out, nil
}

func (p *NacosProvider) GetConfig(profile ConnectionProfile, ref ConfigRef) (ConfigDocument, error) {
	content, err := p.client.GetConfig(profile.BaseURL, profile.AccessToken, profile.APIVersion, ref.Namespace, ref.DataID, ref.Group)
	if err != nil {
		return ConfigDocument{}, err
	}
	return ConfigDocument{
		Ref:     normalizeRef(profile, ref),
		Content: content,
		Source:  string(ProviderNacos),
	}, nil
}

func (p *NacosProvider) PublishConfig(profile ConnectionProfile, req PublishConfigRequest) error {
	ref := normalizeRef(profile, req.Ref)
	return p.client.PublishConfig(profile.BaseURL, profile.AccessToken, profile.APIVersion, ref.Namespace, ref.DataID, ref.Group, req.Content, req.Format)
}

func (p *NacosProvider) DeleteConfig(profile ConnectionProfile, ref ConfigRef) error {
	ref = normalizeRef(profile, ref)
	return p.client.DeleteConfig(profile.BaseURL, profile.AccessToken, profile.APIVersion, ref.Namespace, ref.DataID, ref.Group)
}

func (p *NacosProvider) ListHistory(profile ConnectionProfile, ref ConfigRef, page PageRequest) (HistoryPage, error) {
	ref = normalizeRef(profile, ref)
	history, err := p.client.HistoryList(profile.BaseURL, profile.AccessToken, profile.APIVersion, ref.Namespace, ref.DataID, ref.Group, page.PageNo, page.PageSize)
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
		})
	}
	return out, nil
}

func (p *NacosProvider) GetHistoryDetail(profile ConnectionProfile, ref ConfigRef, id string) (HistoryDetail, error) {
	ref = normalizeRef(profile, ref)
	detail, err := p.client.HistoryDetail(profile.BaseURL, profile.AccessToken, profile.APIVersion, ref.Namespace, ref.DataID, ref.Group, id)
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
	}, nil
}

func (p *NacosProvider) TestConnection(profile ConnectionProfile) error {
	_, err := p.client.Namespaces(profile.BaseURL, profile.AccessToken, profile.APIVersion)
	return err
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

package main

import (
	"context"

	"confscope/internal/nacos"
)

// App 是 Wails 暴露给前端的应用服务。
//
// 这一层只做桌面端方法绑定和参数转发，具体 Nacos HTTP 协议适配由
// internal/nacos.Client 负责，避免前端绑定层混入业务解析逻辑。
type App struct {
	ctx   context.Context
	nacos *nacos.Client
}

// NewApp 创建应用服务实例。
func NewApp() *App {
	return &App{nacos: nacos.NewClient()}
}

// startup 保存 Wails 运行上下文，供后续需要调用运行时能力时使用。
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// NacosDetectVersion 探测目标 Nacos 服务应使用 v1 还是 v3 OpenAPI。
func (a *App) NacosDetectVersion(baseUrl string) (string, error) {
	return a.nacos.DetectVersion(baseUrl)
}

// NacosLogin 使用账号密码登录 Nacos，并返回 accessToken 与过期时间。
func (a *App) NacosLogin(baseUrl string, username string, password string, apiVersion string) (nacos.LoginResult, error) {
	return a.nacos.Login(baseUrl, username, password, apiVersion)
}

// NacosNamespaces 查询命名空间列表。
func (a *App) NacosNamespaces(baseUrl string, accessToken string, apiVersion string) ([]nacos.Namespace, error) {
	return a.nacos.Namespaces(baseUrl, accessToken, apiVersion)
}

// NacosListConfigs 按 dataId/group 模糊查询配置列表。
func (a *App) NacosListConfigs(
	baseUrl string,
	accessToken string,
	apiVersion string,
	namespace string,
	dataId string,
	group string,
	pageNo int64,
	pageSize int64,
) (nacos.ConfigPage, error) {
	return a.nacos.ListConfigs(baseUrl, accessToken, apiVersion, namespace, dataId, group, pageNo, pageSize)
}

// NacosGetConfig 获取指定配置的完整内容。
func (a *App) NacosGetConfig(
	baseUrl string,
	accessToken string,
	apiVersion string,
	namespace string,
	dataId string,
	group string,
) (string, error) {
	return a.nacos.GetConfig(baseUrl, accessToken, apiVersion, namespace, dataId, group)
}

// NacosHistoryList 查询指定配置的历史版本列表。
func (a *App) NacosHistoryList(
	baseUrl string,
	accessToken string,
	apiVersion string,
	namespace string,
	dataId string,
	group string,
	pageNo int64,
	pageSize int64,
) (nacos.HistoryPage, error) {
	return a.nacos.HistoryList(baseUrl, accessToken, apiVersion, namespace, dataId, group, pageNo, pageSize)
}

// NacosHistoryDetail 获取指定历史版本的详情。
func (a *App) NacosHistoryDetail(
	baseUrl string,
	accessToken string,
	apiVersion string,
	namespace string,
	dataId string,
	group string,
	nid string,
) (nacos.HistoryDetail, error) {
	return a.nacos.HistoryDetail(baseUrl, accessToken, apiVersion, namespace, dataId, group, nid)
}

// NacosPublishConfig 发布或更新指定配置。
func (a *App) NacosPublishConfig(
	baseUrl string,
	accessToken string,
	apiVersion string,
	namespace string,
	dataId string,
	group string,
	content string,
	configType string,
) error {
	return a.nacos.PublishConfig(baseUrl, accessToken, apiVersion, namespace, dataId, group, content, configType)
}

// NacosDeleteConfig 删除指定配置。
func (a *App) NacosDeleteConfig(
	baseUrl string,
	accessToken string,
	apiVersion string,
	namespace string,
	dataId string,
	group string,
) error {
	return a.nacos.DeleteConfig(baseUrl, accessToken, apiVersion, namespace, dataId, group)
}

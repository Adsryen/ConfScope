package main

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"

	"confscope/internal/provider"
	"confscope/internal/updatecheck"
)

func newAppIPv4Server(t *testing.T, handler http.Handler) *httptest.Server {
	t.Helper()

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp4: %v", err)
	}

	server := httptest.NewUnstartedServer(handler)
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	return server
}

func TestGetAppInfoReturnsVersionAndDefaultUpdateSources(t *testing.T) {
	info := NewApp().GetAppInfo()

	if info.Name != "ConfScope" {
		t.Fatalf("Name = %q, want ConfScope", info.Name)
	}
	if info.Version == "" {
		t.Fatal("Version is empty")
	}
	if len(info.UpdateSources) < 3 {
		t.Fatalf("len(UpdateSources) = %d, want at least 3", len(info.UpdateSources))
	}
}

func TestCheckForUpdatesUsesAppVersionWhenCurrentVersionIsEmpty(t *testing.T) {
	server := newAppIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"version":"9.9.9",
			"downloadUrl":"https://download.example.com/ConfScope.exe"
		}`))
	}))

	result := NewApp().CheckForUpdates(updatecheck.Request{
		Sources: []updatecheck.Source{
			{Name: "test", URL: server.URL + "/update.json"},
		},
	})

	if result.CurrentVersion == "" {
		t.Fatal("CurrentVersion is empty")
	}
	if !result.HasUpdate || result.LatestVersion != "9.9.9" {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestNewAppRegistersNacosProvider(t *testing.T) {
	app := NewApp()

	p, err := app.providerFor(provider.ProviderNacos)
	if err != nil {
		t.Fatalf("providerFor returned error: %v", err)
	}
	if p == nil {
		t.Fatal("providerFor returned nil provider")
	}
	if _, ok := p.(*provider.NacosProvider); !ok {
		t.Fatalf("provider type = %T, want *provider.NacosProvider", p)
	}
}

type fakeConfigProvider struct {
	calls []string
}

func (f *fakeConfigProvider) record(name string) {
	f.calls = append(f.calls, name)
}

func (f *fakeConfigProvider) ListNamespaces(profile provider.ConnectionProfile) ([]provider.Namespace, error) {
	f.record("ListNamespaces:" + string(profile.Provider))
	return []provider.Namespace{{ID: "ns-a", Name: "Namespace A"}}, nil
}

func (f *fakeConfigProvider) ListConfigs(profile provider.ConnectionProfile, req provider.ListConfigsRequest) (provider.ConfigPage, error) {
	f.record("ListConfigs:" + req.Namespace)
	return provider.ConfigPage{TotalCount: 1, PageItems: []provider.ConfigSummary{{Ref: provider.ConfigRef{DataID: "app.yaml"}}}}, nil
}

func (f *fakeConfigProvider) GetConfig(profile provider.ConnectionProfile, ref provider.ConfigRef) (provider.ConfigDocument, error) {
	f.record("GetConfig:" + ref.DataID)
	return provider.ConfigDocument{Ref: ref, Content: "a: 1"}, nil
}

func (f *fakeConfigProvider) PublishConfig(profile provider.ConnectionProfile, req provider.PublishConfigRequest) error {
	f.record("PublishConfig:" + req.Ref.DataID)
	return nil
}

func (f *fakeConfigProvider) DeleteConfig(profile provider.ConnectionProfile, ref provider.ConfigRef) error {
	f.record("DeleteConfig:" + ref.DataID)
	return nil
}

func (f *fakeConfigProvider) ListHistory(profile provider.ConnectionProfile, ref provider.ConfigRef, page provider.PageRequest) (provider.HistoryPage, error) {
	f.record("ListHistory:" + ref.DataID)
	return provider.HistoryPage{TotalCount: 1, PageItems: []provider.HistoryItem{{ID: "42", Ref: ref}}}, nil
}

func (f *fakeConfigProvider) GetHistoryDetail(profile provider.ConnectionProfile, ref provider.ConfigRef, id string) (provider.HistoryDetail, error) {
	f.record("GetHistoryDetail:" + id)
	return provider.HistoryDetail{ID: id, Ref: ref, Content: "a: 1"}, nil
}

func (f *fakeConfigProvider) TestConnection(profile provider.ConnectionProfile) error {
	f.record("TestConnection:" + string(profile.Provider))
	return nil
}

func TestConfigCenterMethodsDispatchToRegisteredProvider(t *testing.T) {
	app := NewApp()
	fake := &fakeConfigProvider{}
	app.providers[provider.ProviderLocal] = fake
	profile := provider.ConnectionProfile{ID: "local-1", Provider: provider.ProviderLocal}
	ref := provider.ConfigRef{Provider: provider.ProviderLocal, ConnectionID: "local-1", DataID: "app.yaml"}

	if namespaces, err := app.ConfigCenterListNamespaces(profile); err != nil || len(namespaces) != 1 {
		t.Fatalf("ConfigCenterListNamespaces = %+v, %v", namespaces, err)
	}
	if page, err := app.ConfigCenterListConfigs(profile, provider.ListConfigsRequest{Namespace: "public"}); err != nil || page.TotalCount != 1 {
		t.Fatalf("ConfigCenterListConfigs = %+v, %v", page, err)
	}
	if doc, err := app.ConfigCenterGetConfig(profile, ref); err != nil || doc.Content != "a: 1" {
		t.Fatalf("ConfigCenterGetConfig = %+v, %v", doc, err)
	}
	if err := app.ConfigCenterPublishConfig(profile, provider.PublishConfigRequest{Ref: ref}); err != nil {
		t.Fatalf("ConfigCenterPublishConfig returned error: %v", err)
	}
	if err := app.ConfigCenterDeleteConfig(profile, ref); err != nil {
		t.Fatalf("ConfigCenterDeleteConfig returned error: %v", err)
	}
	if history, err := app.ConfigCenterListHistory(profile, ref, provider.PageRequest{PageNo: 1, PageSize: 20}); err != nil || history.TotalCount != 1 {
		t.Fatalf("ConfigCenterListHistory = %+v, %v", history, err)
	}
	if detail, err := app.ConfigCenterGetHistoryDetail(profile, ref, "42"); err != nil || detail.ID != "42" {
		t.Fatalf("ConfigCenterGetHistoryDetail = %+v, %v", detail, err)
	}
	if err := app.ConfigCenterTestConnection(profile); err != nil {
		t.Fatalf("ConfigCenterTestConnection returned error: %v", err)
	}

	want := []string{
		"ListNamespaces:local",
		"ListConfigs:public",
		"GetConfig:app.yaml",
		"PublishConfig:app.yaml",
		"DeleteConfig:app.yaml",
		"ListHistory:app.yaml",
		"GetHistoryDetail:42",
		"TestConnection:local",
	}
	if len(fake.calls) != len(want) {
		t.Fatalf("calls = %#v, want %#v", fake.calls, want)
	}
	for i := range want {
		if fake.calls[i] != want[i] {
			t.Fatalf("calls[%d] = %q, want %q; all calls: %#v", i, fake.calls[i], want[i], fake.calls)
		}
	}
}

func TestConfigCenterMethodsRejectUnsupportedProvider(t *testing.T) {
	app := NewApp()

	_, err := app.ConfigCenterListNamespaces(provider.ConnectionProfile{Provider: provider.ProviderApollo})
	if err == nil {
		t.Fatal("ConfigCenterListNamespaces returned nil error")
	}
	if !errors.Is(err, errUnsupportedProvider) {
		t.Fatalf("error = %v, want errUnsupportedProvider", err)
	}
}

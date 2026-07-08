package provider

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newProviderApolloIPv4Server(t *testing.T, handler http.Handler) *httptest.Server {
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

func TestApolloProviderImplementsConfigProvider(t *testing.T) {
	var _ ConfigProvider = NewApolloProvider(nil)
}

func TestApolloProviderListsNamespacesAndConfigs(t *testing.T) {
	server := newProviderApolloIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "apollo-token" {
			t.Fatalf("missing Authorization header")
		}
		w.Header().Set("Content-Type", "application/json")

		switch r.URL.Path {
		case "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces":
			_, _ = w.Write([]byte(`[
				{"appId":"order-service","clusterName":"default","namespaceName":"application","format":"properties","items":[]},
				{"appId":"order-service","clusterName":"default","namespaceName":"datasource.json","format":"json","items":[]}
			]`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))

	p := NewApolloProvider(nil)
	profile := ConnectionProfile{
		ID:                  "apollo-1",
		Provider:            ProviderApollo,
		BaseURL:             server.URL,
		AccessToken:         "apollo-token",
		ApolloEnv:           "DEV",
		ApolloAppID:         "order-service",
		ApolloCluster:       "default",
		ApolloNamespaceName: "application",
	}

	namespaces, err := p.ListNamespaces(profile)
	if err != nil {
		t.Fatalf("ListNamespaces returned error: %v", err)
	}
	if len(namespaces) != 1 {
		t.Fatalf("len(namespaces) = %d, want app-level namespace", len(namespaces))
	}
	if namespaces[0].ID != "order-service" || namespaces[0].Name != "order-service / DEV / default" || namespaces[0].ConfigCount != 2 {
		t.Fatalf("unexpected namespace: %+v", namespaces[0])
	}

	page, err := p.ListConfigs(profile, ListConfigsRequest{Namespace: "order-service", PageNo: 1, PageSize: 20})
	if err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
	if page.TotalCount != 2 || len(page.PageItems) != 2 {
		t.Fatalf("unexpected page: %+v", page)
	}
	first := page.PageItems[0]
	if first.Ref.Provider != ProviderApollo || first.Ref.ConnectionID != "apollo-1" || first.Ref.Namespace != "order-service" || first.Ref.Group != "default" || first.Ref.DataID != "application" {
		t.Fatalf("unexpected ref: %+v", first.Ref)
	}
	if first.Format != "properties" {
		t.Fatalf("Format = %q, want properties", first.Format)
	}
}

func TestApolloProviderGetsConfigWithDeterministicContent(t *testing.T) {
	server := newProviderApolloIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"appId":"order-service",
			"clusterName":"default",
			"namespaceName":"application",
			"format":"properties",
			"items":[
				{"key":"z.key","value":"last","dataChangeLastModifiedTime":"2026-07-07T10:02:00+08:00"},
				{"key":"a.key","value":"first","dataChangeLastModifiedTime":"2026-07-07T10:01:00+08:00"}
			]
		}`))
	}))

	p := NewApolloProvider(nil)
	profile := ConnectionProfile{
		ID:          "apollo-1",
		Provider:    ProviderApollo,
		BaseURL:     server.URL,
		AccessToken: "apollo-token",
		ApolloEnv:   "DEV",
	}
	doc, err := p.GetConfig(profile, ConfigRef{
		Provider:  ProviderApollo,
		Namespace: "order-service",
		Group:     "default",
		DataID:    "application",
	})
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if doc.Ref.Provider != ProviderApollo || doc.Ref.ConnectionID != "apollo-1" || doc.Ref.Namespace != "order-service" || doc.Ref.Group != "default" || doc.Ref.DataID != "application" {
		t.Fatalf("unexpected ref: %+v", doc.Ref)
	}
	if doc.Content != "a.key=first\nz.key=last\n" {
		t.Fatalf("Content = %q, want sorted properties", doc.Content)
	}
	if doc.Format != "properties" || doc.Source != "apollo:DEV/order-service/default/application" || doc.UpdateTime != "2026-07-07T10:02:00+08:00" {
		t.Fatalf("unexpected document metadata: %+v", doc)
	}
}

func TestApolloProviderTestsConnectionWithConfiguredNamespace(t *testing.T) {
	server := newProviderApolloIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/openapi/v1/envs/UAT/apps/order-service/clusters/default/namespaces/application" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"appId":"order-service",
			"clusterName":"default",
			"namespaceName":"application",
			"format":"properties",
			"items":[{"key":"server.port","value":"8080"}]
		}`))
	}))

	err := NewApolloProvider(nil).TestConnection(ConnectionProfile{
		ID:                  "apollo-1",
		Provider:            ProviderApollo,
		BaseURL:             server.URL,
		AccessToken:         "apollo-token",
		ApolloEnv:           "UAT",
		ApolloAppID:         "order-service",
		ApolloCluster:       "default",
		ApolloNamespaceName: "application",
	})
	if err != nil {
		t.Fatalf("TestConnection returned error: %v", err)
	}
}

func TestApolloProviderRejectsReadonlyOperations(t *testing.T) {
	p := NewApolloProvider(nil)
	profile := ConnectionProfile{ID: "apollo-1", Provider: ProviderApollo}
	ref := ConfigRef{Provider: ProviderApollo, ConnectionID: "apollo-1", Namespace: "order-service", Group: "default", DataID: "application"}

	if _, err := p.ListHistory(profile, ref, PageRequest{}); !errors.Is(err, errApolloReadOnly) {
		t.Fatalf("ListHistory error = %v, want errApolloReadOnly", err)
	}
	if _, err := p.GetHistoryDetail(profile, ref, "1"); !errors.Is(err, errApolloReadOnly) {
		t.Fatalf("GetHistoryDetail error = %v, want errApolloReadOnly", err)
	}
}

func TestApolloProviderRequiresTargetNamespaceForConnectionTest(t *testing.T) {
	err := NewApolloProvider(nil).TestConnection(ConnectionProfile{
		ID:          "apollo-1",
		Provider:    ProviderApollo,
		BaseURL:     "http://apollo.example.com",
		AccessToken: "apollo-token",
		ApolloEnv:   "DEV",
		ApolloAppID: "order-service",
	})
	if err == nil {
		t.Fatal("TestConnection returned nil error")
	}
	if !strings.Contains(err.Error(), "Apollo namespaceName") {
		t.Fatalf("error = %q, want namespaceName hint", err.Error())
	}
}

func TestApolloProviderPublishesPropertiesDocumentAndReleases(t *testing.T) {
	var upserts []map[string]string
	var deletes []string
	released := false
	server := newProviderApolloIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "apollo-token" {
			t.Fatalf("Authorization = %q, want apollo-token", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application":
			_, _ = w.Write([]byte(`{
				"appId":"order-service",
				"clusterName":"default",
				"namespaceName":"application",
				"format":"properties",
				"items":[
					{"key":"server.port","value":"8080"},
					{"key":"feature.enabled","value":"false"},
					{"key":"old.removed","value":"yes"}
				]
			}`))
		case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application/items/"):
			if r.URL.Query().Get("createIfNotExists") != "true" {
				t.Fatalf("createIfNotExists = %q, want true", r.URL.Query().Get("createIfNotExists"))
			}
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatalf("decode upsert body: %v", err)
			}
			upserts = append(upserts, body)
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application/items/"):
			deletes = append(deletes, strings.TrimPrefix(r.URL.Path, "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application/items/"))
		case r.Method == http.MethodPost && r.URL.Path == "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application/releases":
			released = true
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.String())
		}
	}))

	err := NewApolloProvider(nil).PublishConfig(apolloProfile(server.URL), PublishConfigRequest{
		Ref:     apolloRef("__document"),
		Content: "server.port=8081\nfeature.enabled=true\n",
		Format:  "properties",
	})
	if err != nil {
		t.Fatalf("PublishConfig returned error: %v", err)
	}
	if len(upserts) != 2 {
		t.Fatalf("len(upserts) = %d, want 2: %+v", len(upserts), upserts)
	}
	if upserts[0]["key"] != "feature.enabled" || upserts[0]["value"] != "true" {
		t.Fatalf("unexpected first upsert: %+v", upserts[0])
	}
	if upserts[1]["key"] != "server.port" || upserts[1]["value"] != "8081" {
		t.Fatalf("unexpected second upsert: %+v", upserts[1])
	}
	if len(deletes) != 1 || deletes[0] != "old.removed" {
		t.Fatalf("deletes = %+v, want old.removed", deletes)
	}
	if !released {
		t.Fatal("namespace was not released")
	}
}

func TestApolloProviderDeletesPropertiesDocumentItemsAndReleases(t *testing.T) {
	var deletes []string
	released := false
	server := newProviderApolloIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application":
			_, _ = w.Write([]byte(`{
				"appId":"order-service",
				"clusterName":"default",
				"namespaceName":"application",
				"format":"properties",
				"items":[
					{"key":"server.port","value":"8080"},
					{"key":"feature.enabled","value":"false"}
				]
			}`))
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application/items/"):
			deletes = append(deletes, strings.TrimPrefix(r.URL.Path, "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application/items/"))
		case r.Method == http.MethodPost && r.URL.Path == "/openapi/v1/envs/DEV/apps/order-service/clusters/default/namespaces/application/releases":
			released = true
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.String())
		}
	}))

	err := NewApolloProvider(nil).DeleteConfig(apolloProfile(server.URL), apolloRef("__document"))
	if err != nil {
		t.Fatalf("DeleteConfig returned error: %v", err)
	}
	if len(deletes) != 2 || deletes[0] != "feature.enabled" || deletes[1] != "server.port" {
		t.Fatalf("deletes = %+v, want sorted item deletes", deletes)
	}
	if !released {
		t.Fatal("namespace was not released")
	}
}

func TestApolloProviderBlocksNonPropertiesPublish(t *testing.T) {
	err := NewApolloProvider(nil).PublishConfig(apolloProfile("http://apollo.example.test"), PublishConfigRequest{
		Ref:     apolloRef("__document"),
		Content: `{"server.port":8081}`,
		Format:  "json",
	})
	if err == nil {
		t.Fatal("PublishConfig returned nil error")
	}
	if !strings.Contains(err.Error(), "properties") {
		t.Fatalf("error = %q, want properties boundary", err.Error())
	}
}

func apolloProfile(baseURL string) ConnectionProfile {
	return ConnectionProfile{
		ID:          "apollo-1",
		Provider:    ProviderApollo,
		BaseURL:     baseURL,
		AccessToken: "apollo-token",
		ApolloEnv:   "DEV",
	}
}

func apolloRef(key string) ConfigRef {
	return ConfigRef{
		Provider:     ProviderApollo,
		ConnectionID: "apollo-1",
		Namespace:    "order-service",
		Group:        "default",
		DataID:       "application",
		Key:          key,
	}
}

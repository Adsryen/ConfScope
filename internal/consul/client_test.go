package consul

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newConsulIPv4Server(t *testing.T, handler http.Handler) *httptest.Server {
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

func TestClientListsDatacentersWithTokenHeader(t *testing.T) {
	server := newConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Fatalf("method = %s, want GET", r.Method)
		}
		if r.URL.Path != "/v1/catalog/datacenters" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("X-Consul-Token") != "consul-token" {
			t.Fatalf("X-Consul-Token = %q, want consul-token", r.Header.Get("X-Consul-Token"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`["dc1","dc2"]`))
	}))

	datacenters, err := NewClient().Datacenters(server.URL, "consul-token")
	if err != nil {
		t.Fatalf("Datacenters returned error: %v", err)
	}
	if len(datacenters) != 2 || datacenters[0] != "dc1" || datacenters[1] != "dc2" {
		t.Fatalf("datacenters = %#v, want dc1/dc2", datacenters)
	}
}

func TestClientListsKVWithRecurseAndDatacenter(t *testing.T) {
	server := newConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/kv/apps/order/" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("dc") != "dc1" || r.URL.Query().Get("recurse") != "true" {
			t.Fatalf("query = %s, want dc=dc1&recurse=true", r.URL.RawQuery)
		}
		if r.Header.Get("X-Consul-Token") != "consul-token" {
			t.Fatalf("missing token header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
			{"Key":"apps/order/app.yaml","Value":"c2VydmVyOgogIHBvcnQ6IDgwODAK","CreateIndex":10,"ModifyIndex":42},
			{"Key":"apps/order/feature.json","Value":"eyJlbmFibGVkIjp0cnVlfQ==","CreateIndex":11,"ModifyIndex":43}
		]`))
	}))

	pairs, err := NewClient().ListKV(server.URL, "consul-token", "dc1", "apps/order/")
	if err != nil {
		t.Fatalf("ListKV returned error: %v", err)
	}
	if len(pairs) != 2 {
		t.Fatalf("len(pairs) = %d, want 2", len(pairs))
	}
	if pairs[0].Key != "apps/order/app.yaml" || pairs[0].Value != "c2VydmVyOgogIHBvcnQ6IDgwODAK" || pairs[0].ModifyIndex != 42 {
		t.Fatalf("unexpected first pair: %+v", pairs[0])
	}
}

func TestClientGetsKVAndDecodesBase64Value(t *testing.T) {
	server := newConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/kv/apps/order/app.yaml" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("dc") != "dc1" {
			t.Fatalf("query = %s, want dc=dc1", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"Key":"apps/order/app.yaml","Value":"c2VydmVyOgogIHBvcnQ6IDgwODAK","CreateIndex":10,"ModifyIndex":42}]`))
	}))

	pair, err := NewClient().GetKV(server.URL, "consul-token", "dc1", "apps/order/app.yaml")
	if err != nil {
		t.Fatalf("GetKV returned error: %v", err)
	}
	content, err := DecodeValue(pair)
	if err != nil {
		t.Fatalf("DecodeValue returned error: %v", err)
	}
	if content != "server:\n  port: 8080\n" {
		t.Fatalf("content = %q, want decoded yaml", content)
	}
}

func TestClientReturnsStatusErrorsWithBody(t *testing.T) {
	server := newConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`permission denied`))
	}))

	_, err := NewClient().ListKV(server.URL, "bad-token", "dc1", "apps/order/")
	if err == nil {
		t.Fatal("ListKV returned nil error")
	}
	if !strings.Contains(err.Error(), "Consul 返回 403") || !strings.Contains(err.Error(), "permission denied") {
		t.Fatalf("error = %q, want status and body", err.Error())
	}
}

func TestClientPutsKVWithCAS(t *testing.T) {
	server := newConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Fatalf("method = %s, want PUT", r.Method)
		}
		if r.URL.Path != "/v1/kv/apps/order/app.yaml" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("dc") != "dc1" || r.URL.Query().Get("cas") != "42" {
			t.Fatalf("query = %s, want dc=dc1&cas=42", r.URL.RawQuery)
		}
		if r.Header.Get("X-Consul-Token") != "consul-token" {
			t.Fatalf("missing token header")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll request body: %v", err)
		}
		if string(body) != "server:\n  port: 9090\n" {
			t.Fatalf("body = %q, want raw KV value", string(body))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`true`))
	}))

	err := NewClient().PutKV(server.URL, "consul-token", "dc1", "apps/order/app.yaml", "server:\n  port: 9090\n", 42)
	if err != nil {
		t.Fatalf("PutKV returned error: %v", err)
	}
}

func TestClientCreatesKVWithCASZero(t *testing.T) {
	server := newConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("cas") != "0" {
			t.Fatalf("query = %s, want cas=0", r.URL.RawQuery)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`true`))
	}))

	if err := NewClient().PutKV(server.URL, "", "dc1", "apps/order/new.yaml", "created: true\n", 0); err != nil {
		t.Fatalf("PutKV returned error: %v", err)
	}
}

func TestClientReturnsCASConflictWhenPutReturnsFalse(t *testing.T) {
	server := newConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`false`))
	}))

	err := NewClient().PutKV(server.URL, "", "dc1", "apps/order/app.yaml", "server: 9090\n", 42)
	if err == nil {
		t.Fatal("PutKV returned nil error")
	}
	if !strings.Contains(err.Error(), "CAS") || !strings.Contains(err.Error(), "apps/order/app.yaml") {
		t.Fatalf("error = %q, want CAS conflict with key", err.Error())
	}
}

func TestClientDeletesKVWithCAS(t *testing.T) {
	server := newConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Fatalf("method = %s, want DELETE", r.Method)
		}
		if r.URL.Path != "/v1/kv/apps/order/app.yaml" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("dc") != "dc1" || r.URL.Query().Get("cas") != "42" {
			t.Fatalf("query = %s, want dc=dc1&cas=42", r.URL.RawQuery)
		}
		if r.Header.Get("X-Consul-Token") != "consul-token" {
			t.Fatalf("missing token header")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`true`))
	}))

	err := NewClient().DeleteKV(server.URL, "consul-token", "dc1", "apps/order/app.yaml", 42)
	if err != nil {
		t.Fatalf("DeleteKV returned error: %v", err)
	}
}

func TestClientReturnsCASConflictWhenDeleteReturnsFalse(t *testing.T) {
	server := newConsulIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`false`))
	}))

	err := NewClient().DeleteKV(server.URL, "", "dc1", "apps/order/app.yaml", 42)
	if err == nil {
		t.Fatal("DeleteKV returned nil error")
	}
	if !strings.Contains(err.Error(), "CAS") || !strings.Contains(err.Error(), "apps/order/app.yaml") {
		t.Fatalf("error = %q, want CAS conflict with key", err.Error())
	}
}

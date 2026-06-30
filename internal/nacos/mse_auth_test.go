package nacos

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
	"time"
)

func expectedMSESignature(secret, namespace, group, timestamp string) string {
	if namespace == "public" {
		namespace = ""
	}
	resource := group
	if namespace != "" && group != "" {
		resource = namespace + "+" + group
	} else if namespace != "" {
		resource = namespace
	}
	signText := timestamp
	if resource != "" {
		signText = resource + "+" + timestamp
	}
	mac := hmac.New(sha1.New, []byte(secret))
	_, _ = mac.Write([]byte(signText))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestListConfigsAddsMSEAuthHeaders(t *testing.T) {
	now := time.UnixMilli(1710000000123)
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/cs/configs" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		q := r.URL.Query()
		if q.Get("tenant") != "public" || q.Get("group") != "DEFAULT_GROUP" || q.Get("dataId") != "app" {
			t.Fatalf("unexpected query: %s", r.URL.RawQuery)
		}
		if r.Header.Get("Spas-AccessKey") != "ak-test" {
			t.Fatalf("missing Spas-AccessKey header")
		}
		if r.Header.Get("Timestamp") != "1710000000123" {
			t.Fatalf("Timestamp = %q", r.Header.Get("Timestamp"))
		}
		wantSignature := expectedMSESignature("sk-test", "public", "DEFAULT_GROUP", "1710000000123")
		if r.Header.Get("Spas-Signature") != wantSignature {
			t.Fatalf("Spas-Signature = %q, want %q", r.Header.Get("Spas-Signature"), wantSignature)
		}
		if got := r.Header.Get("Spas-SecurityToken"); got != "sts-token" {
			t.Fatalf("Spas-SecurityToken = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"totalCount":0,"pageNumber":1,"pagesAvailable":0,"pageItems":[]}`))
	}))

	client := NewClient()
	client.clock = func() time.Time { return now }
	client.SetMSEAuth(MSEAuth{
		AccessKeyID:     "ak-test",
		AccessKeySecret: "sk-test",
		SecurityToken:   "sts-token",
	})

	if _, err := client.ListConfigs(server.URL, "", "v1", "public", "app", "DEFAULT_GROUP", 1, 20); err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
}

func TestListConfigsRetriesMSEWithNacosContextOnRoot404(t *testing.T) {
	now := time.UnixMilli(1710000000123)
	paths := []string{}
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.URL.Path == "/v1/cs/configs" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path != "/nacos/v1/cs/configs" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Spas-AccessKey") != "ak-test" {
			t.Fatalf("missing Spas-AccessKey header")
		}
		wantSignature := expectedMSESignature("sk-test", "public", "DEFAULT_GROUP", "1710000000123")
		if r.Header.Get("Spas-Signature") != wantSignature {
			t.Fatalf("Spas-Signature = %q, want %q", r.Header.Get("Spas-Signature"), wantSignature)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"totalCount":0,"pageNumber":1,"pagesAvailable":0,"pageItems":[]}`))
	}))

	client := NewClient()
	client.clock = func() time.Time { return now }
	client.SetMSEAuth(MSEAuth{
		AccessKeyID:     "ak-test",
		AccessKeySecret: "sk-test",
	})

	if _, err := client.ListConfigs(server.URL, "", "v1", "public", "", "DEFAULT_GROUP", 1, 1); err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
	if strings.Join(paths, ",") != "/v1/cs/configs,/nacos/v1/cs/configs" {
		t.Fatalf("paths = %v", paths)
	}
}

func TestListConfigsDoesNotRetryNacosContextWhenBaseURLAlreadyHasContext(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/nacos/v1/cs/configs" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		http.NotFound(w, r)
	}))

	client := NewClient()
	client.SetMSEAuth(MSEAuth{
		AccessKeyID:     "ak-test",
		AccessKeySecret: "sk-test",
	})

	_, err := client.ListConfigs(server.URL+"/nacos", "", "v1", "public", "", "DEFAULT_GROUP", 1, 1)
	if err == nil {
		t.Fatal("ListConfigs returned nil error")
	}
	if !strings.Contains(err.Error(), "请求 /nacos/v1/cs/configs") {
		t.Fatalf("error = %q", err.Error())
	}
}

func TestListConfigsSkipsMSEAuthWhenCredentialsAreMissing(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Spas-AccessKey") != "" || r.Header.Get("Spas-Signature") != "" || r.Header.Get("Timestamp") != "" {
			t.Fatalf("unexpected MSE auth headers: %v", r.Header)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"totalCount":0,"pageNumber":1,"pagesAvailable":0,"pageItems":[]}`))
	}))

	client := NewClient()
	client.SetMSEAuth(MSEAuth{AccessKeyID: "ak-test"})

	if _, err := client.ListConfigs(server.URL, "", "v1", "public", "app", "DEFAULT_GROUP", 1, 20); err != nil {
		t.Fatalf("ListConfigs returned error: %v", err)
	}
}

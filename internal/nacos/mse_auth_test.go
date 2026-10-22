package nacos

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
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

// 轮60 根因守卫：连接声明走 MSE AK/SK 但凭据不完整时，绝不允许退化成匿名请求。
// 匿名请求会被服务端挡成 403 accessKeyId can't be null，用户无从自查（真机复现过）。
func TestListConfigsFailsFastWhenMSECredentialsIncomplete(t *testing.T) {
	var reached int32
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&reached, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"totalCount":0,"pageNumber":1,"pagesAvailable":0,"pageItems":[]}`))
	}))

	client := NewClient()
	client.SetMSEAuth(MSEAuth{AccessKeyID: "ak-test"})

	_, err := client.ListConfigs(server.URL, "", "v1", "public", "app", "DEFAULT_GROUP", 1, 20)
	if !errors.Is(err, ErrMSEAuthMissing) {
		t.Fatalf("err = %v, want ErrMSEAuthMissing", err)
	}
	if !strings.Contains(err.Error(), "AccessKey") {
		t.Fatalf("error must tell the user to refill credentials: %q", err.Error())
	}
	if atomic.LoadInt32(&reached) != 0 {
		t.Fatal("must not send an anonymous request when MSE credentials are incomplete")
	}
}

// 写入路径的签名守卫（轮60 403 的直接回归）：第 5 步执行变更用的就是这条链路，
// 以前它只存在于不带签名的遗留绑定里。
func TestPublishConfigAddsMSEAuthHeaders(t *testing.T) {
	now := time.UnixMilli(1710000000123)
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s", r.Method)
		}
		if r.URL.Path != "/v1/cs/configs" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Spas-AccessKey") != "ak-test" {
			t.Fatal("write path must carry Spas-AccessKey")
		}
		if r.Header.Get("Timestamp") != "1710000000123" {
			t.Fatalf("Timestamp = %q", r.Header.Get("Timestamp"))
		}
		want := expectedMSESignature("sk-test", "public", "DEFAULT_GROUP", "1710000000123")
		if r.Header.Get("Spas-Signature") != want {
			t.Fatalf("Spas-Signature = %q, want %q", r.Header.Get("Spas-Signature"), want)
		}
		_, _ = w.Write([]byte("true"))
	}))

	client := NewClient()
	client.clock = func() time.Time { return now }
	client.SetMSEAuth(MSEAuth{AccessKeyID: "ak-test", AccessKeySecret: "sk-test"})

	if err := client.PublishConfig(server.URL, "", "v1", "public", "app.yaml", "DEFAULT_GROUP", "a: 1", "yaml"); err != nil {
		t.Fatalf("PublishConfig returned error: %v", err)
	}
}

func TestPublishConfigFailsFastWhenMSECredentialsIncomplete(t *testing.T) {
	var reached int32
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&reached, 1)
		_, _ = w.Write([]byte("true"))
	}))

	client := NewClient()
	client.SetMSEAuth(MSEAuth{AccessKeyID: "ak-test", AccessKeySecret: ""})

	err := client.PublishConfig(server.URL, "", "v1", "public", "app.yaml", "DEFAULT_GROUP", "a: 1", "yaml")
	if !errors.Is(err, ErrMSEAuthMissing) {
		t.Fatalf("err = %v, want ErrMSEAuthMissing", err)
	}
	if atomic.LoadInt32(&reached) != 0 {
		t.Fatal("write must not reach the server without signing")
	}
}

// 开源 Nacos（未标注 MSE）仍按匿名/token 走，不被新守卫误伤。
func TestOpenSourceNacosClientDoesNotRequireMSEAuth(t *testing.T) {
	server := newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Spas-AccessKey") != "" {
			t.Fatal("open-source client must not sign")
		}
		_, _ = w.Write([]byte("true"))
	}))

	if err := NewClient().PublishConfig(server.URL, "", "v1", "public", "app.yaml", "DEFAULT_GROUP", "a: 1", "yaml"); err != nil {
		t.Fatalf("PublishConfig returned error: %v", err)
	}
}

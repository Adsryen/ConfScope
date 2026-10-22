package nacos

// 轮65 WP-A 的另一半：服务端把 "accessKeyId can't be null" 原文甩回界面时，
// 用户既看不懂也不知道该做什么（2026-10-22 真机第 5 步 403）。
// 翻译的判据是「这次请求到底带没带签名」：没带 → 教他填凭据；
// 带了还被拒 → 教他查密钥归属与权限，不能再让他去填 AccessKey（那是误导）。

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const mseAccessKeyForbiddenBody = `{"timestamp":"2026-10-22T09:42:16.230+0800","status":403,"error":"Forbidden","message":"authorization failed:Code: -305, Message: Type:some of your request parameters are invalid.DetailInfo:accessKeyId can't be null.","path":"/nacos/v1/cs/configs"}`

func newForbiddenServer(t *testing.T, body string, hits *int32) *httptest.Server {
	t.Helper()
	return newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(hits, 1)
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(body))
	}))
}

func TestForbiddenAccessKeyErrorBecomesActionableOnRead(t *testing.T) {
	var hits int32
	server := newForbiddenServer(t, mseAccessKeyForbiddenBody, &hits)

	_, err := NewClient().ListConfigs(server.URL, "", "v1", "public", "app", "DEFAULT_GROUP", 1, 20)
	if !errors.Is(err, ErrAccessKeyRejected) {
		t.Fatalf("err = %v, want ErrAccessKeyRejected", err)
	}
	message := err.Error()
	if !strings.Contains(message, "AccessKey") || !strings.Contains(message, "连接设置") {
		t.Fatalf("错误必须告诉用户该做什么，实际是: %q", message)
	}
	for _, raw := range []string{"Code: -305", "some of your request parameters are invalid", "\"timestamp\""} {
		if strings.Contains(message, raw) {
			t.Fatalf("不该把服务端原文转述给用户（含 %q）: %q", raw, message)
		}
	}
	if !strings.Contains(message, "/v1/cs/configs") {
		t.Fatalf("错误里要保留请求路径便于自查: %q", message)
	}
	if atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("hits = %d, want 1", atomic.LoadInt32(&hits))
	}
}

func TestForbiddenAccessKeyErrorBecomesActionableOnWrite(t *testing.T) {
	var hits int32
	server := newForbiddenServer(t, mseAccessKeyForbiddenBody, &hits)

	err := NewClient().PublishConfig(server.URL, "", "v1", "public", "app.yaml", "DEFAULT_GROUP", "a: 1", "yaml")
	if !errors.Is(err, ErrAccessKeyRejected) {
		t.Fatalf("写路径的 403 没走同一套翻译: %v", err)
	}
	if !strings.Contains(err.Error(), "连接设置") {
		t.Fatalf("错误必须给出动作: %q", err.Error())
	}
}

func TestForbiddenAccessKeyErrorWhenAlreadySigned(t *testing.T) {
	var hits int32
	server := newForbiddenServer(t, mseAccessKeyForbiddenBody, &hits)

	client := NewClient()
	client.SetMSEAuth(MSEAuth{AccessKeyID: "ak-test", AccessKeySecret: "sk-test"})

	_, err := client.ListConfigs(server.URL, "", "v1", "public", "app", "DEFAULT_GROUP", 1, 20)
	if !errors.Is(err, ErrAccessKeyRejected) {
		t.Fatalf("err = %v, want ErrAccessKeyRejected", err)
	}
	if !strings.Contains(err.Error(), "已带") {
		t.Fatalf("已签名却被拒时不能再教用户填 AccessKey（那是误导）: %q", err.Error())
	}
	if !strings.Contains(err.Error(), "权限") {
		t.Fatalf("该提示检查密钥归属/权限: %q", err.Error())
	}
}

func TestForbiddenWithoutAccessKeyHintKeepsServerResponse(t *testing.T) {
	var hits int32
	server := newForbiddenServer(t, `{"message":"token expired, please login again"}`, &hits)

	_, err := NewClient().ListConfigs(server.URL, "", "v1", "public", "app", "DEFAULT_GROUP", 1, 20)
	if err == nil {
		t.Fatal("want error")
	}
	if errors.Is(err, ErrAccessKeyRejected) {
		t.Fatalf("与 AccessKey 无关的 403 不该被翻译成签名问题: %q", err.Error())
	}
	if !strings.Contains(err.Error(), "Nacos 返回 403") || !strings.Contains(err.Error(), "token expired") {
		t.Fatalf("其它 403 仍要保留服务端原话: %q", err.Error())
	}
}

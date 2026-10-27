package nacos

// 轮101：写操作被服务端拒时，用户看到的必须是可以照着做的话。
//
// 覆盖的现场全部来自 2026-10-22 真机第 5 步失败后的真实报文形状（用户贴回的原文）
// 与 Nacos/MSE 的已知表态方式：
//   - 403/401 说「没权限」        -> 告诉他找谁开什么权限，别让他去重填 AccessKey
//   - 403 说 AccessKey 缺失/被拒  -> 仍走轮65 那条出口（优先级不许被新形状抢走）
//   - 403 说登录态过期            -> 不猜，原话留着
//   - 200 但正文 false / 信封 message 为空 -> 说清哪份配置没写成、服务端给了什么、接下来查什么

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 真机原文（用户提供）：这条已经在轮65 被翻译成动作，本轮不许倒退。
const realAccessKeyMissingBody = `{"timestamp":"2026-10-22T09:42:16.230+0800","status":403,"error":"Forbidden","message":"authorization failed:Code: -305, Message: Type:some of your request parameters are invalid.DetailInfo:accessKeyId can't be null.","path":"/nacos/v1/cs/configs"}`

// RAM 子账号缺写权限时 MSE 的常见形状：状态是 403，报文中途开始讲权限，跟 AccessKey 无关。
const ramPermissionDeniedBody = `{"timestamp":"2026-10-27T10:11:12.000+0800","status":403,"error":"Forbidden","message":"User not allowed to operate on the specified resource: no permission for namespace app / group DEFAULT_GROUP.","path":"/nacos/v1/cs/configs"}`

// 只有一层指向词的形状：本轮明确不翻译（宁可留原文，也不猜成权限问题把人派去找管理员）。
const loginExpiredBody = `{"message":"token expired, please login again"}`

func TestWriteRefusedByPermissionBecomesActionable(t *testing.T) {
	server := newHTTPStatusServer(t, http.StatusForbidden, ramPermissionDeniedBody)

	err := NewClient().PublishConfig(server.URL, "", "v1", "app", "common.yml", "DEFAULT_GROUP", "a: 1", "yaml")
	if !errors.Is(err, ErrConfigPermissionDenied) {
		t.Fatalf("权限形状的 403 没走权限出口: %v", err)
	}
	if errors.Is(err, ErrAccessKeyRejected) {
		t.Fatalf("权限不足不该同时报成签名问题: %q", err.Error())
	}
	message := err.Error()
	for _, want := range []string{"管理员", "写入权限", "重填 AccessKey 不会改变结果"} {
		if !strings.Contains(message, want) {
			t.Fatalf("错误里缺 %q，用户照着做不了: %q", want, message)
		}
	}
	// 与签名被拒共用同一口径：不许把排障 JSON 转述给用户。
	for _, raw := range []string{"timestamp", "DetailInfo", "some of your request parameters"} {
		if strings.Contains(message, raw) {
			t.Fatalf("不该转述服务端排障原文（含 %q）: %q", raw, message)
		}
	}
	if !strings.Contains(message, "/v1/cs/configs") {
		t.Fatalf("要保留请求路径便于自查: %q", message)
	}
}

func TestUnauthorizedStatusAlsoClassified(t *testing.T) {
	server := newHTTPStatusServer(t, http.StatusUnauthorized, `{"error":"Unauthorized","message":"acl deny: unauthorized action, permission required"}`)

	err := NewClient().DeleteConfig(server.URL, "", "v1", "app", "common.yml", "DEFAULT_GROUP")
	if !errors.Is(err, ErrConfigPermissionDenied) {
		t.Fatalf("401 的权限形状不该退化成原文兜底: %v", err)
	}
}

func TestPermissionAdviceDiffersBetweenReadAndWrite(t *testing.T) {
	server := newHTTPStatusServer(t, http.StatusForbidden, ramPermissionDeniedBody)

	_, readErr := NewClient().ListConfigs(server.URL, "", "v1", "app", "common.yml", "DEFAULT_GROUP", 1, 20)
	if readErr == nil || !strings.Contains(readErr.Error(), "读取权限") {
		t.Fatalf("读路径要报「读取权限」: %v", readErr)
	}
	writeErr := NewClient().PublishConfig(server.URL, "", "v1", "app", "common.yml", "DEFAULT_GROUP", "a: 1", "yaml")
	if writeErr == nil || !strings.Contains(writeErr.Error(), "写入权限") {
		t.Fatalf("写路径要报「写入权限」: %v", writeErr)
	}
}

func TestAccessKeyShapeKeepsPriorityOverPermissionShape(t *testing.T) {
	// 真机原文里同时有 Forbidden 与 authorization failed：先认 AccessKey，
	// 否则用户会被派去找管理员开权限，而真正缺的是凭据。
	server := newHTTPStatusServer(t, http.StatusForbidden, realAccessKeyMissingBody)

	err := NewClient().PublishConfig(server.URL, "", "v1", "app", "common.yml", "DEFAULT_GROUP", "a: 1", "yaml")
	if !errors.Is(err, ErrAccessKeyRejected) {
		t.Fatalf("AccessKey 形状必须优先: %v", err)
	}
	if errors.Is(err, ErrConfigPermissionDenied) {
		t.Fatalf("签名问题不能报成权限问题: %q", err.Error())
	}
}

func TestSingleLayerForbiddenKeepsServerResponse(t *testing.T) {
	server := newHTTPStatusServer(t, http.StatusForbidden, loginExpiredBody)

	_, err := NewClient().ListConfigs(server.URL, "", "v1", "public", "app", "DEFAULT_GROUP", 1, 20)
	if err == nil {
		t.Fatal("want error")
	}
	if errors.Is(err, ErrConfigPermissionDenied) {
		t.Fatalf("只有一层指向词就定性成权限问题是猜: %q", err.Error())
	}
	if !strings.Contains(err.Error(), "Nacos 返回 403") || !strings.Contains(err.Error(), "token expired") {
		t.Fatalf("认不出来时必须保留服务端原话: %q", err.Error())
	}
}

func TestV1PublishFalseNamesLocationAndChecks(t *testing.T) {
	server := newHTTPStatusServer(t, http.StatusOK, "false")

	err := NewClient().PublishConfig(server.URL, "", "v1", "app", "common.yml", "DEFAULT_GROUP", "a: 1", "yaml")
	if !errors.Is(err, ErrConfigWriteRefused) {
		t.Fatalf("正文 false 没走写入被拒出口: %v", err)
	}
	message := err.Error()
	if strings.HasSuffix(message, "false") || strings.HasSuffix(message, ": ") {
		t.Fatalf("界面只剩两个字或以空白结尾，用户无从下手: %q", message)
	}
	for _, want := range []string{"发布未写成", "app/DEFAULT_GROUP/common.yml", "只回了 false", "有没有这项操作的权限", "正文与所选格式"} {
		if !strings.Contains(message, want) {
			t.Fatalf("错误缺 %q: %q", want, message)
		}
	}
}

func TestV1DeleteFalseUsesDeleteAction(t *testing.T) {
	server := newHTTPStatusServer(t, http.StatusOK, "false")

	err := NewClient().DeleteConfig(server.URL, "", "v1", "app", "common.yml", "DEFAULT_GROUP")
	if !errors.Is(err, ErrConfigWriteRefused) {
		t.Fatalf("删除的 false 正文没走写入被拒出口: %v", err)
	}
	if !strings.Contains(err.Error(), "删除未写成") || !strings.Contains(err.Error(), "app/DEFAULT_GROUP/common.yml") {
		t.Fatalf("删除要按删除说并带坐标: %q", err.Error())
	}
}

func TestV3RefusalKeepsServerMessage(t *testing.T) {
	server := newHTTPStatusServer(t, http.StatusOK, `{"code":1,"message":"caused: invalid dataId ;"}`)

	err := NewClient().PublishConfig(server.URL, "", "v3", "app", "common.yml", "DEFAULT_GROUP", "a: 1", "yaml")
	if !errors.Is(err, ErrConfigWriteRefused) {
		t.Fatalf("v3 信封 code 非 0 没走写入被拒出口: %v", err)
	}
	if !strings.Contains(err.Error(), "服务端原话：caused: invalid dataId ;") {
		t.Fatalf("v3 给了 message 就必须原话留着: %q", err.Error())
	}
}

func TestRefusalWithoutAnyReasonSaysSo(t *testing.T) {
	server := newHTTPStatusServer(t, http.StatusOK, "")

	err := NewClient().PublishConfig(server.URL, "", "v1", "app", "common.yml", "DEFAULT_GROUP", "a: 1", "yaml")
	if err == nil || !strings.Contains(err.Error(), "服务端没有给出任何原因") {
		t.Fatalf("空正文要明说没给原因，不能留空白: %v", err)
	}

	envelope := newHTTPStatusServer(t, http.StatusOK, `{"code":500,"data":false}`)
	err = NewClient().DeleteConfig(envelope.URL, "", "v3", "app", "common.yml", "DEFAULT_GROUP")
	if err == nil || !strings.Contains(err.Error(), "服务端没有给出任何原因") {
		t.Fatalf("v3 缺 message 同样要明说: %v", err)
	}
}

func TestDecodeFailureMessageIsReadableChinese(t *testing.T) {
	// 源码里曾被工具写成 ASCII 问号（2026-07-23 起），界面就照抄一串问号。
	_, err := decodeResponseBody([]byte("whatever"), "application/json; charset=not-a-real-codec")
	if err == nil {
		t.Fatal("want error")
	}
	message := err.Error()
	if strings.Contains(message, "?") {
		t.Fatalf("错误文案里的问号是 mojibake 残留: %q", message)
	}
	if !strings.Contains(message, "无法按响应声明的编码") {
		t.Fatalf("要说清是响应声明的编码解不开: %q", message)
	}
}

// newHTTPStatusServer 起一个固定状态码 + 固定报文的假服务端，模拟被拒现场。
func newHTTPStatusServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	return newIPv4Server(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
}

// 错误文案会被界面显示、被写进操作历史、被用户复制到别处贴给别人。
// Nacos v1 的 accessToken 就挂在查询串里，抄原文等于把会话令牌一起发出去（轮101）。
func TestErrorTextMasksAccessTokenInQuery(t *testing.T) {
	server := newHTTPStatusServer(t, http.StatusInternalServerError, "boom")

	_, err := NewClient().ListConfigs(server.URL, "SECRET-TOKEN-123", "v1", "app", "common.yml", "DEFAULT_GROUP", 1, 20)
	if err == nil {
		t.Fatal("want error")
	}
	message := err.Error()
	if strings.Contains(message, "SECRET-TOKEN-123") {
		t.Fatalf("accessToken 泄漏进错误文案: %q", message)
	}
	if !strings.Contains(message, "accessToken=***") {
		t.Fatalf("要显式标出被遮掉的参数，不能悄悄删掉: %q", message)
	}
	// 遮凭据不能把线索一起丢掉：定位到「哪一份配置」的坐标必须还在。
	for _, want := range []string{"common.yml", "DEFAULT_GROUP", "app"} {
		if !strings.Contains(message, want) {
			t.Fatalf("错误文案丢了排查线索 %q: %q", want, message)
		}
	}
}

func TestSanitizeQueryKeepsNonSensitiveParams(t *testing.T) {
	masked := sanitizeQuery("dataId=a.yml&group=G1&tenant=ns")
	if masked != "dataId=a.yml&group=G1&tenant=ns" {
		t.Fatalf("普通参数不该被动: %q", masked)
	}
	for _, key := range []string{"password=hunter2", "SecurityToken=abc", "AccessKey=AKID", "accessToken=xyz"} {
		name := key[:strings.Index(key, "=")]
		out := sanitizeQuery(name + "=hunter2")
		if strings.Contains(out, "hunter2") || !strings.Contains(out, "***") {
			t.Fatalf("%s 没被遮掉: %q", name, out)
		}
	}
	if got := sanitizeQuery("a=1&&b=2"); got != "a=1&&b=2" {
		t.Fatalf("空段不该被动: %q", got)
	}
}

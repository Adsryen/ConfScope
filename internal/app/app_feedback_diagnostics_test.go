package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// 反馈文本是「用户原样粘进公开 Issue」的东西，所以这个测试守的不是功能而是边界：
// 今天只有五项事实，明天谁顺手加一个 DataDir 或 LastError，用户名、内网主机名就跟着进公开仓库了。
// 轮64 的截图事故是同一类：内容打了码，元数据里躺着 C:\Users\<真人>\。
func TestFeedbackDiagnosticsCarriesOnlySanitizedShapeFacts(t *testing.T) {
	got := NewApp().GetFeedbackDiagnostics()

	if got.Version == "" {
		t.Fatal("version 为空：反馈里说不清版本，等于没报")
	}
	if want := runtime.GOOS + "-" + runtime.GOARCH; got.Platform != want {
		t.Fatalf("platform = %q，期望 %q", got.Platform, want)
	}
	if got.RuntimeMode != "portable" && got.RuntimeMode != "installed" {
		t.Fatalf("runtimeMode = %q，必须是 portable / installed 之一（判据来自 portabledata 解析器）", got.RuntimeMode)
	}
	if !strings.HasPrefix(got.AssetName, "confscope-") {
		t.Fatalf("assetName = %q，应来自与 release.yml 同源的那张文件名表", got.AssetName)
	}

	// 任何一项里都不许出现路径形态：这个结构体的 JSON 会被前端整块拼进反馈文本。
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	body := string(raw)
	for _, banned := range []string{"/", "\\", string(filepath.Separator)} {
		if strings.Contains(body, banned) {
			t.Fatalf("反馈事实里出现了路径分隔符 %q：%s —— 路径含用户名，不许进公开 Issue", banned, body)
		}
	}
	if home, err := os.UserHomeDir(); err == nil && home != "" && strings.Contains(body, home) {
		t.Fatalf("反馈事实里出现了本机 home 目录：%s", body)
	}
	if user := os.Getenv("USERNAME") + os.Getenv("USER"); user != "" && strings.Contains(body, user) {
		t.Fatalf("反馈事实里出现了当前用户名 %q：%s", user, body)
	}
}

// 前端拿到的是 JSON 字段名，改名要同步改 wailsjs 声明与 About 页，这里把契约钉住。
func TestFeedbackDiagnosticsJSONShape(t *testing.T) {
	raw, err := json.Marshal(NewApp().GetFeedbackDiagnostics())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"version", "platform", "runtimeMode", "packageFormat", "assetName"} {
		if _, ok := fields[key]; !ok {
			t.Fatalf("缺少字段 %q（实际：%s）", key, raw)
		}
	}
	if len(fields) != 5 {
		t.Fatalf("反馈事实必须只有这 5 项，实际 %d 项：%s。加项之前先回答「它会不会泄露」", len(fields), raw)
	}
}

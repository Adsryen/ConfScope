package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

func TestNativeSmokeControlPortFromEnv(t *testing.T) {
	port, ok, err := nativeSmokeControlPortFromEnv(func(key string) string {
		if key == "CONFSCOPE_NATIVE_SMOKE_CONTROL_PORT" {
			return "19222"
		}
		return ""
	})
	if err != nil {
		t.Fatalf("nativeSmokeControlPortFromEnv returned error: %v", err)
	}
	if !ok || port != 19222 {
		t.Fatalf("port = %d, ok = %v; want 19222, true", port, ok)
	}

	_, ok, err = nativeSmokeControlPortFromEnv(func(string) string { return "" })
	if err != nil {
		t.Fatalf("empty env returned error: %v", err)
	}
	if ok {
		t.Fatal("empty env enabled native smoke control")
	}

	_, _, err = nativeSmokeControlPortFromEnv(func(string) string { return "abc" })
	if err == nil {
		t.Fatal("invalid port returned nil error")
	}
}

func TestNativeSmokeControlEvalRoundTrip(t *testing.T) {
	var control *nativeSmokeControl
	var executed string
	control = newNativeSmokeControl("http://127.0.0.1:1", func(script string) {
		executed = script
		id := extractNativeSmokeID(t, script)
		go control.complete(nativeSmokeEvalResult{
			ID:    id,
			OK:    true,
			Value: json.RawMessage(`{"answer":42}`),
		})
	})

	req := httptest.NewRequest(http.MethodPost, "/eval", strings.NewReader(`{"script":"return { answer: 42 };"}`))
	rec := httptest.NewRecorder()
	control.handleEval(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(executed, "return { answer: 42 };") {
		t.Fatalf("executed script = %q, want embedded user script", executed)
	}
	var response struct {
		OK    bool            `json:"ok"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !response.OK || string(response.Value) != `{"answer":42}` {
		t.Fatalf("response = %+v, value = %s", response, response.Value)
	}
}

func TestNativeSmokeControlEvalErrorRoundTrip(t *testing.T) {
	var control *nativeSmokeControl
	control = newNativeSmokeControl("http://127.0.0.1:1", func(script string) {
		id := extractNativeSmokeID(t, script)
		go control.complete(nativeSmokeEvalResult{
			ID:    id,
			OK:    false,
			Error: "boom",
		})
	})

	req := httptest.NewRequest(http.MethodPost, "/eval", strings.NewReader(`{"script":"throw new Error('boom')"}`))
	rec := httptest.NewRecorder()
	control.handleEval(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "boom") {
		t.Fatalf("body = %q, want boom", rec.Body.String())
	}
}

func extractNativeSmokeID(t *testing.T, script string) string {
	t.Helper()
	matches := regexp.MustCompile(`const __confscopeNativeSmokeID = "([^"]+)"`).FindStringSubmatch(script)
	if len(matches) != 2 {
		t.Fatalf("script does not contain native smoke id: %s", script)
	}
	return matches[1]
}

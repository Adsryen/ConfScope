package main

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestNacosDockerApplyPromotionRollbackFlow(t *testing.T) {
	baseURL := os.Getenv("CONFSCOPE_NACOS_INTEGRATION_URL")
	if baseURL == "" {
		t.Skip("set CONFSCOPE_NACOS_INTEGRATION_URL to run the Docker Nacos integration test")
	}

	app := NewApp()
	namespace := os.Getenv("CONFSCOPE_NACOS_INTEGRATION_NAMESPACE")
	apiVersion := "v1"
	dataID := fmt.Sprintf("confscope-it-%d.yaml", time.Now().UnixNano())
	devGroup := "CS_IT_DEV"
	sandboxGroup := "CS_IT_SANDBOX"
	prodGroup := "CS_IT_PROD"
	deleteGroup := "CS_IT_DELETE"
	devContent := "server:\n  port: 8080\nfeature: true\n"
	sandboxContent := "server:\n  port: 9090\nfeature: false\n"
	prodContent := "server:\n  port: 7070\nfeature: false\n"

	t.Cleanup(func() {
		for _, group := range []string{devGroup, sandboxGroup, prodGroup, deleteGroup} {
			_ = app.NacosDeleteConfigFromApplyPlan(baseURL, "", apiVersion, namespace, dataID, group)
		}
	})

	err := app.NacosPublishConfig(baseURL, "", apiVersion, namespace, dataID, devGroup, "should-not-write", "yaml")
	if err == nil || !strings.Contains(err.Error(), "ApplyPlan") {
		t.Fatalf("NacosPublishConfig error = %v, want ApplyPlan guard", err)
	}
	if _, err := app.NacosGetConfig(baseURL, "", apiVersion, namespace, dataID, devGroup); err == nil {
		t.Fatal("direct write guard allowed config to be created")
	}

	publish := func(group string, content string) {
		t.Helper()
		if err := app.NacosPublishConfigFromApplyPlan(baseURL, "", apiVersion, namespace, dataID, group, content, "yaml"); err != nil {
			t.Fatalf("publish %s: %v", group, err)
		}
	}
	read := func(group string) string {
		t.Helper()
		content, err := app.NacosGetConfig(baseURL, "", apiVersion, namespace, dataID, group)
		if err != nil {
			t.Fatalf("get %s: %v", group, err)
		}
		return content
	}
	waitForContent := func(group string, want string) {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		var last string
		var lastErr error
		for time.Now().Before(deadline) {
			content, err := app.NacosGetConfig(baseURL, "", apiVersion, namespace, dataID, group)
			if err == nil {
				last = content
				if content == want {
					return
				}
			} else {
				lastErr = err
			}
			time.Sleep(250 * time.Millisecond)
		}
		if lastErr != nil {
			t.Fatalf("get %s did not converge: last error %v", group, lastErr)
		}
		t.Fatalf("get %s did not converge: last content = %q, want %q", group, last, want)
	}
	waitForDeleted := func(group string) {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		var last string
		for time.Now().Before(deadline) {
			content, err := app.NacosGetConfig(baseURL, "", apiVersion, namespace, dataID, group)
			if err != nil {
				return
			}
			last = content
			time.Sleep(250 * time.Millisecond)
		}
		t.Fatalf("get %s still readable after delete: last content = %q", group, last)
	}

	publish(devGroup, devContent)
	publish(sandboxGroup, sandboxContent)
	publish(prodGroup, prodContent)

	waitForContent(sandboxGroup, sandboxContent)

	publish(sandboxGroup, read(devGroup))
	waitForContent(sandboxGroup, devContent)

	waitForContent(prodGroup, prodContent)
	beforeProd := read(prodGroup)

	publish(prodGroup, read(sandboxGroup))
	waitForContent(prodGroup, devContent)

	publish(prodGroup, beforeProd)
	waitForContent(prodGroup, prodContent)

	history, err := app.NacosHistoryList(baseURL, "", apiVersion, namespace, dataID, prodGroup, 1, 20)
	if err != nil {
		t.Fatalf("history list: %v", err)
	}
	if history.TotalCount == 0 || len(history.PageItems) == 0 {
		t.Fatalf("history = %+v, want at least one record", history)
	}

	publish(deleteGroup, "delete: true\n")
	if err := app.NacosDeleteConfigFromApplyPlan(baseURL, "", apiVersion, namespace, dataID, deleteGroup); err != nil {
		t.Fatalf("delete from apply plan: %v", err)
	}
	waitForDeleted(deleteGroup)
}

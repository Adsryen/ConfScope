package nacos

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type MSEAuth struct {
	AccessKeyID     string
	AccessKeySecret string
	SecurityToken   string
}

func (a MSEAuth) enabled() bool {
	return a.AccessKeyID != "" && a.AccessKeySecret != ""
}

func (c *Client) applyMSEAuth(req *http.Request, namespace string, group string) {
	if !c.mseAuth.enabled() {
		return
	}
	namespace = normalizeMSENamespace(namespace)
	clock := c.clock
	if clock == nil {
		clock = time.Now
	}
	timestamp := strconv.FormatInt(clock().UnixMilli(), 10)
	req.Header.Set("Spas-AccessKey", c.mseAuth.AccessKeyID)
	req.Header.Set("Timestamp", timestamp)
	req.Header.Set("Spas-Signature", signMSERequest(c.mseAuth.AccessKeySecret, namespace, group, timestamp))
	if c.mseAuth.SecurityToken != "" {
		req.Header.Set("Spas-SecurityToken", c.mseAuth.SecurityToken)
	}
}

func signMSERequest(secret string, namespace string, group string, timestamp string) string {
	namespace = normalizeMSENamespace(namespace)
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

func normalizeMSENamespace(namespace string) string {
	if strings.EqualFold(strings.TrimSpace(namespace), "public") {
		return ""
	}
	return namespace
}

package nacos

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ErrMSEAuthMissing 是「连接声明走阿里云 MSE AK/SK 鉴权，但凭据不完整」的错误。
//
// 以前这种情况会静默退化成匿名请求，被服务端挡在 403 accessKeyId can't be null，
// 用户看到的是一句无法自查的服务端报错（轮60 真机 403）。现在在发出请求前
// 就失败，并把补救动作写在消息里。
var ErrMSEAuthMissing = errors.New("MSE 连接缺少 AccessKey/SecretKey：请在连接设置中重新填写阿里云 AccessKey 后重试")

type MSEAuth struct {
	AccessKeyID     string
	AccessKeySecret string
	SecurityToken   string
}

func (a MSEAuth) enabled() bool {
	return a.AccessKeyID != "" && a.AccessKeySecret != ""
}

// applyMSEAuth 给请求加 MSE 签名头。一旦被标注为 MSE 连接（mseAuthRequired），
// 凭据不完整就是配置错误：直接返回错误，不允许退化成匿名请求。
func (c *Client) applyMSEAuth(req *http.Request, namespace string, group string) error {
	if !c.mseAuth.enabled() {
		if c.mseAuthRequired {
			return ErrMSEAuthMissing
		}
		return nil
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
	return nil
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

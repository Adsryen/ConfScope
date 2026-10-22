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

// ErrAccessKeyRejected 是「服务端在拒绝 AccessKey 鉴权」的错误。
//
// 阿里云 MSE/Nacos 这类 403 的响应体是给自己人排障用的 JSON（Code: -305、
// DetailInfo:accessKeyId can't be null 等），直接转述给用户等于什么都没说。
// 这里把它翻译成能照着做的动作，原始报文只留在开发排查用的路径里。
var ErrAccessKeyRejected = errors.New("阿里云 AccessKey 鉴权未通过")

// asksForAccessKey 认服务端报文里「在向我们要 AccessKey」的字形。
// 匹配不到就照原样报状态码+响应体，绝不猜。
func asksForAccessKey(body string) bool {
	lowered := strings.ToLower(body)
	return strings.Contains(lowered, "accesskey") ||
		strings.Contains(lowered, "access key") ||
		strings.Contains(lowered, "access_key")
}

// accessKeyAdvice 按「这次请求带没带签名」给出下一步动作。
// 已经签了还被拒，再教用户去填 AccessKey 就是把人往沟里带。
func (c *Client) accessKeyAdvice() string {
	if c.mseAuth.enabled() {
		return "请求已带 AccessKey 签名仍被拒绝：请确认这个 AccessKey 属于该实例所在的阿里云账号、仍在有效期内，并且拥有该命名空间的配置读写权限"
	}
	return "该配置中心要求阿里云 AccessKey 签名，而本次请求没有带：请在连接设置中填写 AccessKey/SecretKey（阿里云 MSE 连接还需把发行版设为「阿里云 MSE」、认证方式设为「AK/SK」）"
}

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

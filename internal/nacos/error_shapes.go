package nacos

// 被拒时报文的形状识别与文案（轮101）。
//
// 这一颗只回答一件事：**服务端拒绝了我们，该对用户说什么**。
// 与轮65 定下的口径完全一致——只认字形，命中才翻译成动作；认不出来就照原样把状态码、
// 请求路径和服务端原文交给用户，因为那是他唯一能拿去搜索的东西，不许擦掉。
//
// 为什么权限不足要和签名被拒分开：
//   - ErrAccessKeyRejected 的意思是「凭据本身不对」→ 该去连接设置里重填；
//   - ErrConfigPermissionDenied 的意思是「凭据对，但这个账号没有这项动作的权限」→
//     该去找管理员开策略。把后者翻成前者，用户会反复重填 AccessKey，永远填不对。
//
// 为什么「HTTP 成功但没接受写入」要单独处理：
// Nacos v1 的发布与删除用正文 `true` / `false` 表态，`false` 不带任何原因。
// 以前界面上就是「发布失败: false」两个字——批量第 5 步一次写十几条时，
// 用户连「是哪一份配置没写成」都看不出来，更不知道该做什么。
//
// 判据（哪些情况算失败）在本文件之外，已经定了多年，本轮一个字都没动：
// 这里只改「说了什么」。

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// ErrConfigPermissionDenied 是「身份被认出来了，但这次操作没有权限」。
var ErrConfigPermissionDenied = errors.New("配置中心拒绝了这次操作：当前凭据没有这项权限")

// ErrConfigWriteRefused 是「服务端在 HTTP 上给了成功，但没接受这次写入」。
var ErrConfigWriteRefused = errors.New("这次写入没有被服务端接受")

// permissionDeniedWords 是「拒绝」指向的词，permissionTargetWords 是「权限」指向的词。
// 两层各命中一个才定性：单看 forbidden / 单看 authorization 都不够——
// "token expired, please login again" 这类 403 说的是登录态过期，不是没权限，
// 翻成「去开权限」就是把人往沟里带。命中不了就退回原文兜底。
func isPermissionShape(body string) bool {
	lowered := strings.ToLower(body)
	denied := strings.Contains(lowered, "denied") ||
		strings.Contains(lowered, "not allowed") ||
		strings.Contains(lowered, "forbidden") ||
		strings.Contains(lowered, "unauthorized") ||
		strings.Contains(lowered, "拒绝") ||
		strings.Contains(lowered, "不允许")
	targeted := strings.Contains(lowered, "permission") ||
		strings.Contains(lowered, "authoriz") ||
		strings.Contains(lowered, "权限") ||
		strings.Contains(lowered, "授权") ||
		strings.Contains(lowered, "privilege") ||
		strings.Contains(lowered, "acl")
	return denied && targeted
}

// permissionAdvice 按这次请求是读还是写给动作。
// 结尾那句「重填 AccessKey 不会改变结果」是刻意的：这条错误最常见的误操作就是回去改凭据。
func permissionAdvice(method string) string {
	if isWriteMethod(method) {
		return "请求带着身份被拒：请让该实例的管理员为这个账号（阿里云 RAM 子账号或 Nacos 角色）开放对应命名空间与分组的写入权限，再重试；重填 AccessKey 不会改变结果"
	}
	return "请求带着身份被拒：请让该实例的管理员为这个账号开放对应命名空间与分组的读取权限，再重试；重填 AccessKey 不会改变结果"
}

func isWriteMethod(method string) bool {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
		return true
	default:
		return false
	}
}

// writeRefusal 是一次没被接受的写入。坐标必须带上：批量第 5 步一次写十几条，
// 光说「发布失败」等于让人回去一条条翻。命名沿用界面既有的 命名空间/分组/配置 顺序。
type writeRefusal struct {
	action    string // 界面口径：发布 / 删除
	namespace string
	group     string
	dataID    string
}

// err 把「2xx 但没接受」说清楚：结论、位置、服务端给了什么、接下来查什么。
// body 是 v1 的 true/false 文本或 v3 信封里的 message，两者都可能什么都不带，
// 那也要明说「没有给出原因」，不能让句子以空白结尾。
func (w writeRefusal) err(body string) error {
	reason := refusalReason(body)
	return fmt.Errorf("%w：%s未写成（位置 %s）。%s接下来依次确认：当前凭据对这个命名空间与分组有没有这项操作的权限；"+
		"这份配置是否被他人锁定或所在环境只读；正文与所选格式是否匹配（例如选了 YAML 但正文不是合法 YAML）",
		ErrConfigWriteRefused, w.action, w.location(), reason)
}

func (w writeRefusal) location() string {
	parts := []string{fallback(w.namespace, "默认命名空间"), fallback(w.group, "DEFAULT_GROUP"), fallback(w.dataID, "未取名")}
	return strings.Join(parts, "/")
}

// refusalReason 只描述服务端给了什么，不加判断：
// 空白 = 什么都没说；false = 说了被拒但没说原因；其余把原话留着。
func refusalReason(body string) string {
	trimmed := strings.TrimSpace(body)
	switch {
	case trimmed == "":
		return "服务端没有给出任何原因。"
	case strings.EqualFold(trimmed, "false"):
		return "服务端只回了 false，没有给出原因。"
	default:
		return "服务端原话：" + trimmed + "。"
	}
}

func fallback(value string, absent string) string {
	if strings.TrimSpace(value) == "" {
		return absent
	}
	return value
}

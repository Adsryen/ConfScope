package nacos

import (
	"encoding/json"
	"strconv"
	"strings"
)

// truncate 截断过长的 Nacos 响应文本，用于错误信息展示。
func truncate(text string) string {
	text = strings.TrimSpace(text)
	if len([]rune(text)) <= 300 {
		return text
	}
	runes := []rune(text)
	return string(runes[:300]) + "..."
}

// stringValue 将 Nacos 宽松 JSON 字段转换为字符串。
//
// Nacos 不同版本可能把 id、时间等字段返回为字符串或数字，统一转为字符串后交给前端展示。
func stringValue(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		if x == float64(int64(x)) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	case json.Number:
		return x.String()
	default:
		return ""
	}
}

// s 读取对象中的字符串字段，缺失时返回空字符串。
func s(obj map[string]any, key string) string {
	if obj == nil {
		return ""
	}
	return stringValue(obj[key])
}

// sAny 按顺序读取多个候选字段，返回第一个非空值。
//
// 该函数主要用于兼容 v1/v3 字段名差异，例如 group/groupName、tenant/namespaceId。
func sAny(obj map[string]any, keys ...string) string {
	for _, key := range keys {
		if val := s(obj, key); val != "" {
			return val
		}
	}
	return ""
}

// i 读取对象中的整数字段，缺失或解析失败时返回 0。
func i(obj map[string]any, key string) int64 {
	if obj == nil {
		return 0
	}
	switch x := obj[key].(type) {
	case float64:
		return int64(x)
	case json.Number:
		n, _ := x.Int64()
		return n
	case string:
		n, _ := strconv.ParseInt(x, 10, 64)
		return n
	default:
		return 0
	}
}

// boolValue 读取对象中的布尔字段，缺失或类型不匹配时返回 false。
func boolValue(obj map[string]any, key string) bool {
	if obj == nil {
		return false
	}
	v, _ := obj[key].(bool)
	return v
}

// asObject 将任意 JSON 值转换为对象，类型不匹配时返回 nil。
func asObject(v any) map[string]any {
	obj, _ := v.(map[string]any)
	return obj
}

// asArray 将任意 JSON 值转换为数组，类型不匹配时返回 nil。
func asArray(v any) []any {
	arr, _ := v.([]any)
	return arr
}

// decodeJSON 将响应文本解析为 JSON 对象，并保留数字精度。
func decodeJSON(text string) (map[string]any, error) {
	var v map[string]any
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	if err := dec.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

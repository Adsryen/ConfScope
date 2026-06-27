package nacos

import "strings"

type apiVersion string

const (
	apiV1 apiVersion = "v1"
	apiV3 apiVersion = "v3"
)

// parseAPI 将前端传入的版本字符串规整为内部枚举，无法识别时按 v1 处理。
func parseAPI(version string) apiVersion {
	if strings.EqualFold(version, string(apiV3)) {
		return apiV3
	}
	return apiV1
}

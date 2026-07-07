// Package consul 封装 Consul HTTP API 只读访问逻辑。
package consul

// KVPair 是 Consul KV API 返回的单个 key/value 条目。
type KVPair struct {
	Key         string `json:"Key"`
	Value       string `json:"Value"`
	CreateIndex uint64 `json:"CreateIndex"`
	ModifyIndex uint64 `json:"ModifyIndex"`
}

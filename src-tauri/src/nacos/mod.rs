//! Nacos OpenAPI 客户端，同时兼容两套 API：
//!
//! - **v1**：Nacos 1.x / 2.x。`/v1/cs/configs`、`tenant`/`group`、accessToken 走 query，
//!   响应不带 `{code,data}` 信封，配置内容是纯文本。
//! - **v3**：Nacos 3.x。`/v3/console/*`、`namespaceId`/`groupName`、accessToken 走 **header**，
//!   响应统一 `{code,message,data}` 信封，配置内容在 `data.content`（JSON）。
//!
//! 3.0 起 v1/v2 默认关闭（返回 410 Gone），3.2 起更是从核心发行版移除，因此优先走 v3。
//! 前端先用 [`nacos_detect_version`] 探测一次版本并缓存，再把 `api_version` 传给后续命令。
//!
//! 响应统一用 serde_json::Value 宽松解析：不同版本对时间、id、字段名（group/groupName、
//! tenant/namespaceId、lastModifiedTime/modifyTime）不一致，按「先读这个、空了再读那个」兜底。

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, PartialEq)]
enum Api {
    V1,
    V3,
}

fn parse_api(s: &str) -> Api {
    if s.eq_ignore_ascii_case("v3") {
        Api::V3
    } else {
        Api::V1
    }
}

// ───────────────────────── 返回类型 ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub access_token: String,
    pub token_ttl: i64,
    pub global_admin: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Namespace {
    pub namespace: String,
    pub namespace_show_name: String,
    pub config_count: i64,
    pub kind: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigItem {
    pub data_id: String,
    pub group: String,
    pub content: String,
    pub config_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPage {
    pub total_count: i64,
    pub page_number: i64,
    pub pages_available: i64,
    pub page_items: Vec<ConfigItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub id: String,
    pub data_id: String,
    pub group: String,
    pub op_type: String,
    /// v1 是字符串时间；v3 是 epoch 毫秒（按字符串透传，前端统一格式化）。
    pub last_modified_time: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    pub total_count: i64,
    pub page_number: i64,
    pub pages_available: i64,
    pub page_items: Vec<HistoryItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDetail {
    pub id: String,
    pub data_id: String,
    pub group: String,
    pub content: String,
    pub op_type: String,
    pub created_time: String,
    pub last_modified_time: String,
}

// ───────────────────────── 工具函数 ─────────────────────────

fn base(base_url: &str) -> String {
    base_url.trim_end_matches('/').to_string()
}

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(TIMEOUT)
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))
}

fn truncate(s: &str) -> String {
    let s = s.trim();
    if s.chars().count() > 300 {
        format!("{}…", s.chars().take(300).collect::<String>())
    } else {
        s.to_string()
    }
}

/// 取字符串字段；数字/布尔会被转成字符串，缺失返回空串。
fn s(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

/// 依次尝试多个 key，返回第一个非空的字符串（兼容 v1/v3 字段名差异）。
fn s_any(v: &Value, keys: &[&str]) -> String {
    for k in keys {
        let val = s(v, k);
        if !val.is_empty() {
            return val;
        }
    }
    String::new()
}

fn i(v: &Value, key: &str) -> i64 {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(x)) => x.parse().unwrap_or(0),
        _ => 0,
    }
}

/// 发起 GET 并返回响应体文本。按 API 版本决定 accessToken 放 query 还是 header。
fn get_text(
    base_url: &str,
    path: &str,
    mut query: Vec<(&str, String)>,
    token: &str,
    version: Api,
) -> Result<String, String> {
    let url = format!("{}{}", base(base_url), path);
    let mut rb = client()?.get(&url);
    match version {
        Api::V1 => {
            if !token.is_empty() {
                query.push(("accessToken", token.to_string()));
            }
        }
        Api::V3 => {
            if !token.is_empty() {
                rb = rb.header("accessToken", token);
            }
        }
    }
    let resp = rb
        .query(&query)
        .send()
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().map_err(|e| format!("读取响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("Nacos 返回 {}: {}", status.as_u16(), truncate(&text)));
    }
    Ok(text)
}

/// GET 并解析为 JSON。`unwrap` 为真时按 v3 信封 `{code,message,data}` 取出 data。
fn get_json(
    base_url: &str,
    path: &str,
    query: Vec<(&str, String)>,
    token: &str,
    version: Api,
) -> Result<Value, String> {
    let text = get_text(base_url, path, query, token, version)?;
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析响应 JSON 失败: {e} —— {}", truncate(&text)))?;
    if version == Api::V3 {
        // v3 信封：code != 0 视为业务失败。
        if let Some(code) = v.get("code").and_then(Value::as_i64) {
            if code != 0 {
                let msg = s(&v, "message");
                return Err(format!("Nacos 返回 code={code}: {msg}"));
            }
            return Ok(v.get("data").cloned().unwrap_or(Value::Null));
        }
    }
    Ok(v)
}

// ───────────────────────── Tauri 命令 ─────────────────────────

/// 探测 Nacos API 版本：v3 才有 `/v3/console/core/namespace/list`，
/// 老版本访问它会 404。免鉴权探测（403/200/400 都说明端点存在，即 v3）。
#[tauri::command]
pub async fn nacos_detect_version(base_url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = format!("{}/v3/console/core/namespace/list", base(&base_url));
        match client()?.get(&url).send() {
            Ok(resp) => {
                if resp.status().as_u16() == 404 {
                    Ok("v1".to_string())
                } else {
                    Ok("v3".to_string())
                }
            }
            Err(e) => Err(format!("无法连接到服务器: {e}")),
        }
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

#[tauri::command]
pub async fn nacos_login(
    base_url: String,
    username: String,
    password: String,
    api_version: String,
) -> Result<LoginResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let version = parse_api(&api_version);
        let path = match version {
            Api::V3 => "/v3/auth/user/login",
            Api::V1 => "/v1/auth/login",
        };
        let url = format!("{}{}", base(&base_url), path);
        let resp = client()?
            .post(&url)
            .form(&[("username", &username), ("password", &password)])
            .send()
            .map_err(|e| format!("登录请求失败: {e}"))?;
        let status = resp.status();
        let text = resp.text().map_err(|e| format!("读取登录响应失败: {e}"))?;
        if status.as_u16() == 403 {
            return Err("账号或密码错误（Nacos 返回 403）".into());
        }
        if !status.is_success() {
            return Err(format!("登录失败 {}: {}", status.as_u16(), truncate(&text)));
        }
        let v: Value = serde_json::from_str(&text)
            .map_err(|e| format!("解析登录响应失败: {e} —— {}", truncate(&text)))?;
        // 登录接口在多数版本里是裸对象；个别封装在 data 里，做兜底。
        let body = if v.get("accessToken").is_some() {
            &v
        } else {
            v.get("data").unwrap_or(&v)
        };
        Ok(LoginResult {
            access_token: s(body, "accessToken"),
            token_ttl: i(body, "tokenTtl"),
            global_admin: body
                .get("globalAdmin")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

#[tauri::command]
pub async fn nacos_namespaces(
    base_url: String,
    access_token: String,
    api_version: String,
) -> Result<Vec<Namespace>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let version = parse_api(&api_version);
        let path = match version {
            Api::V3 => "/v3/console/core/namespace/list",
            Api::V1 => "/v1/console/namespaces",
        };
        let data = get_json(&base_url, path, vec![], &access_token, version)?;
        // v3 已解信封返回数组；v1 是 {data:[...]}，再取一层。
        let arr = match &data {
            Value::Array(a) => a.clone(),
            _ => data
                .get("data")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| "命名空间响应缺少 data 数组".to_string())?,
        };
        Ok(arr
            .iter()
            .map(|n| Namespace {
                namespace: s_any(n, &["namespace", "namespaceId"]),
                namespace_show_name: s(n, "namespaceShowName"),
                config_count: i(n, "configCount"),
                kind: i(n, "type"),
            })
            .collect())
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

#[tauri::command]
pub async fn nacos_list_configs(
    base_url: String,
    access_token: String,
    api_version: String,
    namespace: String,
    data_id: String,
    group: String,
    page_no: i64,
    page_size: i64,
) -> Result<ConfigPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let version = parse_api(&api_version);
        let (path, query) = match version {
            Api::V3 => (
                "/v3/console/cs/config/list",
                vec![
                    ("search", "blur".to_string()),
                    ("dataId", data_id),
                    ("groupName", group),
                    ("namespaceId", namespace),
                    ("pageNo", page_no.to_string()),
                    ("pageSize", page_size.to_string()),
                ],
            ),
            Api::V1 => (
                "/v1/cs/configs",
                vec![
                    ("search", "blur".to_string()),
                    ("dataId", data_id),
                    ("group", group),
                    ("tenant", namespace),
                    ("pageNo", page_no.to_string()),
                    ("pageSize", page_size.to_string()),
                ],
            ),
        };
        let data = get_json(&base_url, path, query, &access_token, version)?;
        let items = data
            .get("pageItems")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(ConfigPage {
            total_count: i(&data, "totalCount"),
            page_number: i(&data, "pageNumber"),
            pages_available: i(&data, "pagesAvailable"),
            page_items: items
                .iter()
                .map(|c| ConfigItem {
                    data_id: s(c, "dataId"),
                    group: s_any(c, &["group", "groupName"]),
                    content: s(c, "content"), // v3 列表无 content，点开时再拉
                    config_type: s(c, "type"),
                })
                .collect(),
        })
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

#[tauri::command]
pub async fn nacos_get_config(
    base_url: String,
    access_token: String,
    api_version: String,
    namespace: String,
    data_id: String,
    group: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let version = parse_api(&api_version);
        match version {
            Api::V3 => {
                let query = vec![
                    ("dataId", data_id),
                    ("groupName", group),
                    ("namespaceId", namespace),
                ];
                let data = get_json(&base_url, "/v3/console/cs/config", query, &access_token, version)?;
                Ok(s(&data, "content"))
            }
            Api::V1 => {
                let query = vec![("dataId", data_id), ("group", group), ("tenant", namespace)];
                // v1 直接返回纯文本内容。
                get_text(&base_url, "/v1/cs/configs", query, &access_token, version)
            }
        }
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

#[tauri::command]
pub async fn nacos_history_list(
    base_url: String,
    access_token: String,
    api_version: String,
    namespace: String,
    data_id: String,
    group: String,
    page_no: i64,
    page_size: i64,
) -> Result<HistoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let version = parse_api(&api_version);
        let (path, query) = match version {
            Api::V3 => (
                "/v3/console/cs/history/list",
                vec![
                    ("dataId", data_id),
                    ("groupName", group),
                    ("namespaceId", namespace),
                    ("pageNo", page_no.to_string()),
                    ("pageSize", page_size.to_string()),
                ],
            ),
            Api::V1 => (
                "/v1/cs/history",
                vec![
                    ("search", "accurate".to_string()),
                    ("dataId", data_id),
                    ("group", group),
                    ("tenant", namespace),
                    ("pageNo", page_no.to_string()),
                    ("pageSize", page_size.to_string()),
                ],
            ),
        };
        let data = get_json(&base_url, path, query, &access_token, version)?;
        let items = data
            .get("pageItems")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        Ok(HistoryPage {
            total_count: i(&data, "totalCount"),
            page_number: i(&data, "pageNumber"),
            pages_available: i(&data, "pagesAvailable"),
            page_items: items
                .iter()
                .map(|h| HistoryItem {
                    id: s(h, "id"),
                    data_id: s(h, "dataId"),
                    group: s_any(h, &["group", "groupName"]),
                    op_type: s(h, "opType"),
                    last_modified_time: s_any(h, &["lastModifiedTime", "modifyTime"]),
                })
                .collect(),
        })
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

#[tauri::command]
pub async fn nacos_publish_config(
    base_url: String,
    access_token: String,
    api_version: String,
    namespace: String,
    data_id: String,
    group: String,
    content: String,
    config_type: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let version = parse_api(&api_version);
        let c = client()?;
        match version {
            Api::V3 => {
                // v3 console：表单提交，accessToken 走 header，返回 {code,message,data:bool}
                let url = format!("{}/v3/console/cs/config", base(&base_url));
                let form = [
                    ("dataId", data_id.as_str()),
                    ("groupName", group.as_str()),
                    ("namespaceId", namespace.as_str()),
                    ("content", content.as_str()),
                    ("type", config_type.as_str()),
                ];
                let mut rb = c.post(&url).form(&form);
                if !access_token.is_empty() {
                    rb = rb.header("accessToken", &access_token);
                }
                let resp = rb.send().map_err(|e| format!("发布请求失败: {e}"))?;
                let status = resp.status();
                let text = resp.text().map_err(|e| format!("读取响应失败: {e}"))?;
                if !status.is_success() {
                    return Err(format!("Nacos 返回 {}: {}", status.as_u16(), truncate(&text)));
                }
                let v: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("解析响应失败: {e} —— {}", truncate(&text)))?;
                let ok = v.get("code").and_then(Value::as_i64) == Some(0)
                    && v.get("data").and_then(Value::as_bool) == Some(true);
                if !ok {
                    return Err(format!("发布失败: {}", s(&v, "message")));
                }
                Ok(())
            }
            Api::V1 => {
                // v1：表单提交，accessToken 走 query，成功返回纯文本 "true"
                let url = format!("{}/v1/cs/configs", base(&base_url));
                let form = [
                    ("dataId", data_id.as_str()),
                    ("group", group.as_str()),
                    ("tenant", namespace.as_str()),
                    ("content", content.as_str()),
                    ("type", config_type.as_str()),
                ];
                let mut rb = c.post(&url);
                if !access_token.is_empty() {
                    rb = rb.query(&[("accessToken", access_token.as_str())]);
                }
                let resp = rb.form(&form).send().map_err(|e| format!("发布请求失败: {e}"))?;
                let status = resp.status();
                let text = resp.text().map_err(|e| format!("读取响应失败: {e}"))?;
                if !status.is_success() {
                    return Err(format!("Nacos 返回 {}: {}", status.as_u16(), truncate(&text)));
                }
                if text.trim() != "true" {
                    return Err(format!("发布失败: {}", truncate(&text)));
                }
                Ok(())
            }
        }
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

#[tauri::command]
pub async fn nacos_delete_config(
    base_url: String,
    access_token: String,
    api_version: String,
    namespace: String,
    data_id: String,
    group: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let version = parse_api(&api_version);
        let c = client()?;
        match version {
            Api::V3 => {
                let url = format!("{}/v3/console/cs/config", base(&base_url));
                let query = [
                    ("dataId", data_id.as_str()),
                    ("groupName", group.as_str()),
                    ("namespaceId", namespace.as_str()),
                ];
                let mut rb = c.delete(&url).query(&query);
                if !access_token.is_empty() {
                    rb = rb.header("accessToken", &access_token);
                }
                let resp = rb.send().map_err(|e| format!("删除请求失败: {e}"))?;
                let status = resp.status();
                let text = resp.text().map_err(|e| format!("读取响应失败: {e}"))?;
                if !status.is_success() {
                    return Err(format!("Nacos 返回 {}: {}", status.as_u16(), truncate(&text)));
                }
                let v: Value = serde_json::from_str(&text)
                    .map_err(|e| format!("解析响应失败: {e} —— {}", truncate(&text)))?;
                if v.get("code").and_then(Value::as_i64) != Some(0) {
                    return Err(format!("删除失败: {}", s(&v, "message")));
                }
                Ok(())
            }
            Api::V1 => {
                let url = format!("{}/v1/cs/configs", base(&base_url));
                let mut query = vec![
                    ("dataId", data_id.as_str()),
                    ("group", group.as_str()),
                    ("tenant", namespace.as_str()),
                ];
                if !access_token.is_empty() {
                    query.push(("accessToken", access_token.as_str()));
                }
                let resp = c
                    .delete(&url)
                    .query(&query)
                    .send()
                    .map_err(|e| format!("删除请求失败: {e}"))?;
                let status = resp.status();
                let text = resp.text().map_err(|e| format!("读取响应失败: {e}"))?;
                if !status.is_success() {
                    return Err(format!("Nacos 返回 {}: {}", status.as_u16(), truncate(&text)));
                }
                if text.trim() != "true" {
                    return Err(format!("删除失败: {}", truncate(&text)));
                }
                Ok(())
            }
        }
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

#[tauri::command]
pub async fn nacos_history_detail(
    base_url: String,
    access_token: String,
    api_version: String,
    namespace: String,
    data_id: String,
    group: String,
    nid: String,
) -> Result<HistoryDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let version = parse_api(&api_version);
        let (path, query) = match version {
            Api::V3 => (
                "/v3/console/cs/history",
                vec![
                    ("dataId", data_id),
                    ("groupName", group),
                    ("namespaceId", namespace),
                    ("nid", nid),
                ],
            ),
            Api::V1 => (
                "/v1/cs/history",
                vec![
                    ("dataId", data_id),
                    ("group", group),
                    ("tenant", namespace),
                    ("nid", nid),
                ],
            ),
        };
        let data = get_json(&base_url, path, query, &access_token, version)?;
        Ok(HistoryDetail {
            id: s(&data, "id"),
            data_id: s(&data, "dataId"),
            group: s_any(&data, &["group", "groupName"]),
            content: s(&data, "content"),
            op_type: s(&data, "opType"),
            created_time: s_any(&data, &["createdTime", "createTime"]),
            last_modified_time: s_any(&data, &["lastModifiedTime", "modifyTime"]),
        })
    })
    .await
    .map_err(|e| format!("任务调度失败: {e}"))?
}

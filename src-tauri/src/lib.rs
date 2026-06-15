mod nacos;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            nacos::nacos_detect_version,
            nacos::nacos_login,
            nacos::nacos_namespaces,
            nacos::nacos_list_configs,
            nacos::nacos_get_config,
            nacos::nacos_history_list,
            nacos::nacos_history_detail,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

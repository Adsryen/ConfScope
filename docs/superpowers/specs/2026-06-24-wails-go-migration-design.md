# Wails Go Migration Design

## Goal

Replace the Tauri/Rust desktop backend with Wails v2 and Go so Windows packaging no longer depends on the Rust toolchain.

## Architecture

The React/Vite frontend stays in `src/`. Wails hosts the built `dist/` assets and exposes Go methods directly to the frontend through generated bindings under `wailsjs/`. The Go backend keeps the current Nacos behavior: detect v1/v3 API shape, login, list namespaces/configs/history, fetch config/history detail, publish config, and delete config.

## Components

- `main.go` starts the Wails desktop shell, embeds `dist/`, binds the app service, and keeps the current window size.
- `app.go` exposes Wails methods with frontend-facing names.
- `internal/nacos/` owns Nacos HTTP behavior, response normalization, and tests.
- `src/api/nacos.ts` preserves the existing frontend API surface while replacing Tauri `invoke` calls with Wails Go bindings.
- `wails.json` and `package.json` define Wails development and packaging commands.

## Testing

Go tests cover version detection, v3 response unwrapping, login parsing, and v1/v3 Nacos endpoint mapping using `httptest`. Frontend verification uses TypeScript/Vite build after bindings and imports are updated.

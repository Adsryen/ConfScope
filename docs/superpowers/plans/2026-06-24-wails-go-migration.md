# Wails Go Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Tauri/Rust runtime with Wails v2 and Go while preserving the existing React UI and Nacos behavior.

**Architecture:** Wails embeds the Vite `dist/` output and binds a Go `App` service to the frontend. The Go Nacos package mirrors the current Rust command behavior and `src/api/nacos.ts` keeps the same exported TypeScript functions for components.

**Tech Stack:** Go, Wails v2, React 18, TypeScript, Vite, pnpm.

---

### Task 1: Add Go Nacos Backend

**Files:**
- Create: `go.mod`
- Create: `internal/nacos/client.go`
- Create: `internal/nacos/client_test.go`

- [ ] Write failing Go tests for parsing and endpoint behavior with `httptest`.
- [ ] Run `go test ./internal/nacos` and verify tests fail because the package is missing.
- [ ] Implement `internal/nacos/client.go` with the current v1/v3 Nacos behavior.
- [ ] Run `go test ./internal/nacos` and verify tests pass.

### Task 2: Add Wails App Shell

**Files:**
- Create: `main.go`
- Create: `app.go`
- Create: `wails.json`

- [ ] Bind Go methods matching the frontend needs.
- [ ] Embed `dist/` assets and keep the existing window size.
- [ ] Run `go test ./...` after dependencies are available.

### Task 3: Replace Frontend IPC

**Files:**
- Modify: `src/api/nacos.ts`
- Create: `wailsjs/go/main/App.ts`

- [ ] Replace `@tauri-apps/api/core` imports with Wails binding imports.
- [ ] Keep exported frontend functions and types unchanged.
- [ ] Add a minimal committed binding file so TypeScript works before Wails regenerates bindings.

### Task 4: Update Build Scripts And Docs

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Modify: `README.md`

- [ ] Remove Tauri package dependencies and scripts.
- [ ] Add Wails dev/build scripts.
- [ ] Document Windows exe packaging with `wails build`.

# ConfScope Real-Environment Smoke

`pnpm test:smoke` runs a reusable smoke harness that creates temporary Docker Nacos services, seeds configs, injects a Wails binding bridge into Playwright, and writes reports under `.tmp/full-smoke-<run-id>/reports/`.

Set `CONFSCOPE_SMOKE_KEEP=1` to keep containers after a run for debugging.

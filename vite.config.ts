import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1', // 强制用 IPv4
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/build/**", "**/tests/retest/**", "**/results/**", "**/test-results/**", "**/local-backups/**"],
    },
    optimizeDeps: {
      exclude: ["**/local-backups/**"],
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "e2e/**", "tests/smoke/specs/**", "tests/smoke/native/specs/**", "tests/retest/specs/**", "tests/smoke/bridge/**", "tests/smoke/global-teardown.test.ts", "tests/smoke/native/global-setup.test.ts", "tests/smoke/native/global-teardown.test.ts", ".tmp/**"],
  },
});

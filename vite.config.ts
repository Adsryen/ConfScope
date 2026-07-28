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
      ignored: ["**/build/**"],
    },
  },
  test: {
    exclude: [...configDefaults.exclude, "e2e/**", "tests/smoke/specs/**", "tests/smoke/native/specs/**", ".tmp/**"],
  },
});

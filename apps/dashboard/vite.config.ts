import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Vite's `/mcp` proxy is prefix-based and would also catch SPA route `/mcps`.
 * Only forward the real MCP endpoint (and query/trailing-slash variants).
 */
function mcpProxy(): ProxyOptions {
  return {
    target: "http://127.0.0.1:8080",
    changeOrigin: true,
    bypass(req) {
      const url = req.url ?? "";
      const pathOnly = url.split("?")[0] ?? "";
      if (pathOnly === "/mcp" || pathOnly.startsWith("/mcp/")) {
        return undefined;
      }
      // SPA routes like /mcps — let Vite serve index.html
      return "/index.html";
    },
  };
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@yusetu/shared": path.resolve(rootDir, "../../packages/shared/src/index.ts"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
      "/mcp": mcpProxy(),
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
      "/mcp": mcpProxy(),
    },
  },
});

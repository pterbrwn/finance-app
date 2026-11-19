import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.LEDGER_DEV_API ?? "http://127.0.0.1:3000",
        changeOrigin: true,
        configure: (proxy) => {
          // The local Ledger adapter validates Origin against its own origin.
          // Vite forwards the browser origin, so rewrite it to the proxy target.
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("origin", process.env.LEDGER_DEV_API ?? "http://127.0.0.1:3000")
          })
        },
      },
    },
  },
})

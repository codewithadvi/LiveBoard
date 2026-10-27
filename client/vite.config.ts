import { defineConfig } from "vite";

// In development the page comes from Vite (port 5173) and the realtime server
// runs on 8080. Account requests are proxied so the browser sees one origin.
export default defineConfig({
  server: {
    proxy: { "/api": "http://localhost:8080" },
  },
});

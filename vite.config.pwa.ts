import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";
import path from "node:path";

/**
 * The phone build.
 *
 * A second config rather than a second entry in the desktop build, because the two bundles want
 * opposite things. The desktop bundle is loaded from `tauri://localhost` by a webview that is
 * always the newest one on disk, so it never needs a base path, never needs a service worker
 * and never needs to be installable. This one is served from a real origin over HTTPS, has to
 * work at a sub-path, and is the only place a service worker may live.
 *
 * They share the source tree on purpose: `pwa/` holds the shell, `src/` holds the components,
 * and the question a human answers is the same implementation on both.
 */
const base = process.env.PWA_BASE ?? "/AuraUI/";

export default defineConfig({
  plugins: [react()],
  root: "pwa",
  // Where the site is served from. Overridden by `PWA_BASE` for a custom domain, which is the
  // upgrade path away from GitHub Pages and the only thing that has to change to take it.
  base,
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  /*
   * PostCSS is configured inline because the root is `pwa/`: PostCSS config discovery starts
   * at the project root, and the project root here is one directory up. Letting it find nothing
   * is not a loud failure — the `@tailwind` directives survive into the CSS unprocessed and the
   * app renders as unstyled HTML — so it is set explicitly rather than left to discovery.
   */
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
  server: {
    // Loopback while developing: the pairing payload refuses a plain-http address that is not
    // loopback, because neither a service worker nor the Push API exists outside a secure
    // context, and a dev server that ignored that would be testing a different app.
    host: "127.0.0.1",
    port: 1421,
    strictPort: true,
  },
  build: {
    outDir: "../dist-pwa",
    emptyOutDir: true,
    target: "es2021",
    sourcemap: false,
    minify: "esbuild",
  },
});

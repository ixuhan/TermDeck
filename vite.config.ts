import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Surfaced in the settings panel so the user can see what they are running.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // The workspace hosts a 1.5 GB Rust toolchain and a multi-GB cargo target
      // dir; letting chokidar traverse them makes first-request transform take
      // tens of seconds.
      ignored: [
        "**/src-tauri/**",
        "**/.toolchain/**",
        "**/.cache/**",
        "**/shots/**",
        "**/dist/**",
      ],
    },
  },
  build: {
    target: "chrome110",
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-webgl"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
});

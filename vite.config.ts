import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
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

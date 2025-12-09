import { injectIWER } from "@iwsdk/vite-plugin-iwer";
import { compileUIKit } from "@iwsdk/vite-plugin-uikitml";
import { defineConfig } from "vite";
import mkcert from "vite-plugin-mkcert";
import path from "path";

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  resolve: {
    alias: {
      tslib: path.resolve("node_modules/tslib/tslib.es6.mjs"),
    },
  },
  plugins: [
    mkcert(),
    injectIWER({
      device: "metaQuest3",
      activation: "localhost",
      verbose: true,
      sem: {
        enabled: false, // Disable emulator environment to show starfield
      },
    }),

    compileUIKit({ sourceDir: "ui", outputDir: "public/ui", verbose: true }),
  ],
  server: { host: "0.0.0.0", port: 8081, open: true },
  build: {
    outDir: "dist",
    sourcemap: process.env.NODE_ENV !== "production",
    target: "esnext",
    rollupOptions: { input: "./index.html" },
  },
  esbuild: { target: "esnext" },
  optimizeDeps: {
    exclude: ["@babylonjs/havok"],
    include: ["tslib", "@aws-sdk/client-bedrock-runtime"],
    esbuildOptions: { target: "esnext" },
  },
  publicDir: "public",
  base: "/nanauts/",
});

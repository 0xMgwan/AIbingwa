import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "build",
  format: ["esm"],
  target: "esnext",
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: true,
  dts: false,
});

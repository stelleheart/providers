import { defineConfig } from "tsdown"
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))


export default defineConfig({
  entry: ["./src/index.ts"],
  format: ["esm", "umd"],
  tsconfig: __dirname.concat("/tsconfig.json"),
  outDir: "lib",
  platform: "browser",
  dts: true,
  clean: true,
  globalName: "index",
  exports: true,
  shims: true,
})

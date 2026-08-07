import * as esbuild from "esbuild";

// 확장 호스트 타깃 (CJS)
await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node24",
  external: ["vscode"],
  sourcemap: true,
});

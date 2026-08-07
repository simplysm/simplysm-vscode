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

// webview 타깃 (ESM) — codicon 아이콘 폰트(.ttf)는 file loader 로 dist/webview 에 방출
await esbuild.build({
  entryPoints: ["src/webview/main.ts"],
  outfile: "dist/webview/main.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2024",
  sourcemap: true,
  loader: { ".ttf": "file" },
});

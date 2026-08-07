import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

const ptyPackageName = "@lydell/node-pty";
const require = createRequire(import.meta.url);

// 확장 호스트 타깃 (CJS) — 셸을 띄우는 네이티브 모듈은 번들에 들어가지 않으므로 밖에 둔다
await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node24",
  external: ["vscode", ptyPackageName],
  sourcemap: true,
});

// daemon 타깃 (CJS) — pty 세션을 소유하는 별개 프로세스. vscode 를 절대 import 하지 않는다.
await esbuild.build({
  entryPoints: ["src/daemon.ts"],
  outfile: "dist/daemon.cjs",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node24",
  external: [ptyPackageName],
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

// 네이티브 모듈 동봉 — vsce 는 심볼릭 링크를 따라가지 않아 실제 파일로 복사해야 vsix 에 들어간다.
// dist 하위의 node_modules 는 vsce 의 기본 무시 대상(cwd 기준 node_modules)에 걸리지 않는다.
// Remote-SSH 로 리눅스 호스트에 설치되는 경우까지 같은 vsix 로 덮는다 — node-pty 본체가
// 런타임에 `-${platform}-${arch}` 패키지를 골라 로드하므로 두 플랫폼을 함께 동봉하면 된다.
const bundledPlatforms = ["win32-x64", "linux-x64"];
const ptyEntryPath = require.resolve(ptyPackageName);
copyPackage(ptyPackageName, packageRootOf(ptyEntryPath, ptyPackageName));
for (const platformArch of bundledPlatforms) {
  const platformPackageName = `${ptyPackageName}-${platformArch}`;
  const platformEntryPath = createRequire(ptyEntryPath).resolve(platformPackageName);
  copyPackage(platformPackageName, packageRootOf(platformEntryPath, platformPackageName));
}

/**
 * 같은 버전의 사본이 이미 있으면 건너뛴다 — 확장이 도는 중이면 로드된 네이티브 파일이 잠겨
 * 덮어쓸 수 없다. 버전이 다르면 옛 사본이 그대로 배포되지 않게 지우고 다시 복사한다.
 */
function copyPackage(packageName, sourceDir) {
  const targetDir = path.join("dist", "node_modules", packageName);
  const sourceVersion = JSON.parse(
    fs.readFileSync(path.join(sourceDir, "package.json"), "utf8"),
  ).version;
  const targetManifestPath = path.join(targetDir, "package.json");
  if (fs.existsSync(targetManifestPath)) {
    if (JSON.parse(fs.readFileSync(targetManifestPath, "utf8")).version === sourceVersion) return;
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    // 디버그 심볼은 실행에 쓰이지 않고 확장 크기를 10MB 넘게 늘린다.
    filter: (source) => !source.endsWith(".pdb"),
  });
}

function packageRootOf(entryPath, packageName) {
  let currentDir = path.dirname(entryPath);
  for (;;) {
    const manifestPath = path.join(currentDir, "package.json");
    if (
      fs.existsSync(manifestPath) &&
      JSON.parse(fs.readFileSync(manifestPath, "utf8")).name === packageName
    ) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) throw new Error(`${packageName} 패키지 루트를 찾지 못했습니다.`);
    currentDir = parentDir;
  }
}

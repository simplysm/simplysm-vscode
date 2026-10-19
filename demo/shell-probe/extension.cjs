// 시연 하네스 전용 탐지 확장 — 제품이 아니다. demo/fixtures.ts 의 "시연 셸 탐지" 주석 참고.
// VS Code 가 고른 기본 셸(vscode.env.shell)을 알게 될 때마다, 그 셸과 그때의 터미널 설정(VS Code 기본값과
// 합쳐진 값 — 제품이 읽는 것과 같은 키다)을 이 확장의 전역 저장 폴더에 report-<순번>.json 으로 적는다.
// 터미널은 열지 않는다 — 셸을 띄우지 않는다.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

/** 터미널 설정 키의 OS 끝말 — `terminal.integrated.profiles.windows` · `.osx` · `.linux`. */
const profileOs =
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";

/** @param {import("vscode").ExtensionContext} context */
function activate(context) {
  const reportDir = context.globalStorageUri.fsPath;
  let sequence = 0;
  const report = () => {
    const shell = vscode.env.shell;
    // 기본 프로필이 정해지기 전에는 비어 있다 — 정해지면 onDidChangeShell 이 온다.
    if (shell.length === 0) return;
    const config = vscode.workspace.getConfiguration("terminal.integrated");
    const content = JSON.stringify({
      shell,
      settings: {
        defaultProfileName: config.get(`defaultProfile.${profileOs}`),
        profiles: config.get(`profiles.${profileOs}`),
        useWslProfiles: config.get("useWslProfiles"),
        env: config.get(`env.${profileOs}`),
      },
    });
    sequence++;
    const fileName = `report-${String(sequence).padStart(4, "0")}.json`;
    fs.mkdirSync(reportDir, { recursive: true });
    // 다 쓴 뒤 이름을 붙여, 하네스가 쓰다 만 파일을 읽지 않게 한다.
    const tempPath = path.join(reportDir, `${fileName}.tmp`);
    fs.writeFileSync(tempPath, content);
    fs.renameSync(tempPath, path.join(reportDir, fileName));
  };
  context.subscriptions.push(vscode.env.onDidChangeShell(report));
  report();
}

module.exports = { activate };

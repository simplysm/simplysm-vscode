import * as vscode from "vscode";

// webview html 조립 (spec §4.2) — CSP·로컬 자산·번역 번들 주입.

export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "main.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "main.css"),
  );
  const nonce = crypto.randomUUID().replaceAll("-", "");
  // 번역 번들 inline JSON 주입 — 첫 렌더부터 번역 적용 (spec §4.9).
  // `</script>` 조기 종결 방지 이스케이프 — JSON 의미 불변
  const l10nBundleJson = JSON.stringify(vscode.l10n.bundle ?? {}).replaceAll("</", "<\\/");
  return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
</head>
<body>
  <script nonce="${nonce}">globalThis.__simplysmTasksL10n = ${l10nBundleJson};</script>
  <script type="module" nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

import * as vscode from "vscode";
import { t } from "./l10n.ts";

/**
 * webview 문서 조립. 표시 문자열은 메시지로 받는 것이 원칙이지만, 첫 메시지가 닿기 전에 보일
 * 연결 대기 문구만은 여기서 번역해 문서에 박는다 — 스크립트나 메시지 전달이 어긋난 경우에도
 * 빈 화면 대신 사실이 보여야 한다.
 */
export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "main.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "main.css"),
  );
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const connectingText = escapeHtml(t("Connecting to the terminal service…"));
  const retryText = escapeHtml(
    t("The terminal view is not getting a response from the extension host. Retrying…"),
  );
  // 터미널 에뮬레이터가 글자 칸 크기에 맞춘 규칙을 <style> 요소로 직접 만들어 넣으므로
  // 인라인 스타일을 허용해야 화면이 그려진다. 스크립트는 nonce 로 계속 좁혀 둔다.
  return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri.toString()}">
</head>
<body>
  <div id="handshake" data-retry-text="${retryText}"><p>${connectingText}</p></div>
  <script type="module" nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

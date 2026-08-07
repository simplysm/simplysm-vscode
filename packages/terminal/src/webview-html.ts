import * as vscode from "vscode";

/**
 * webview 문서 조립. 표시 문자열은 담지 않는다 — webview 는 번역 조회 수단을 두지 않고
 * 확장 호스트가 번역을 마친 값만 메시지로 받는다.
 */
export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "main.js"),
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "main.css"),
  );
  const nonce = crypto.randomUUID().replaceAll("-", "");
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
  <script type="module" nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

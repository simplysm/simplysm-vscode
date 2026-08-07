import * as vscode from "vscode";
import { buildWebviewHtml } from "./webview-html.ts";
import { serializeTaskLines, type TaskLine } from "./tasks-model.ts";
import { setL10nBundle, t } from "./l10n.ts";

// 확장 진입점 (spec §4.2·§4.3) — .tasks 커스텀 에디터(리스트 UI) 등록 + 편집 확정 즉시 저장.
// CustomTextEditorProvider (spec §8) — 문서 열기 실패는 VS Code 표준 오류 표시로 표면화.

/** webview → 호스트: 확정 조작 결과 줄 목록(항목·그룹 헤더) (spec §4.3 — 확정 시점에만 기록). */
type WebviewMessage =
  | { type: "ready" }
  | { type: "apply"; lines: TaskLine[] }
  | { type: "history"; action: "undo" | "redo" }
  | { type: "openAsText" };

/**
 * `editor.lineHeight` 설정을 webview 용 CSS line-height 값으로 환산 (VS Code 규칙 준용).
 * - 0 = auto → 브라우저 기본("normal")
 * - 0 < n < 8 = 폰트 크기 배수 → 무단위 값
 * - n >= 8 = 절대 px → `{n}px`
 * VS Code 는 line-height 를 CSS 변수로 주입하지 않아 설정을 직접 읽어 전달한다.
 */
function editorLineHeightCss(): string {
  const editorConfig = vscode.workspace.getConfiguration("editor");
  const lineHeight = editorConfig.get<number>("lineHeight", 0);
  if (lineHeight <= 0) return "normal";
  if (lineHeight < 8) return String(lineHeight);
  return `${lineHeight}px`;
}

/** 활성 tasks 에디터 패널 — historyKey 키바인딩 명령의 전달 대상 (spec §4.5). */
let activeTasksPanel: vscode.WebviewPanel | undefined;

class TasksEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  resolveCustomTextEditor(document: vscode.TextDocument, webviewPanel: vscode.WebviewPanel): void {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = buildWebviewHtml(webviewPanel.webview, this.context.extensionUri);

    // 활성 패널 추적 — 키바인딩(when: activeCustomEditorId)이 눌린 순간의 대상 패널 식별
    if (webviewPanel.active) activeTasksPanel = webviewPanel;
    const viewStateSubscription = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) activeTasksPanel = webviewPanel;
      else if (activeTasksPanel === webviewPanel) activeTasksPanel = undefined;
    });

    const pushDocument = (): void => {
      void webviewPanel.webview.postMessage({ type: "doc", text: document.getText() });
    };

    // editor.lineHeight 를 webview 로 주입 — VS Code 가 CSS 변수로 안 주는 설정을 반영 (spec §4.2).
    const pushConfig = (): void => {
      void webviewPanel.webview.postMessage({ type: "config", lineHeight: editorLineHeightCss() });
    };

    // 자기 편집 전문 — 변경 이벤트는 applyEdit 완료 뒤에도 도착할 수 있으므로 실행 중 여부가 아닌 내용으로 식별.
    // 같은 전문의 외부 이벤트는 UI 상태 변화가 없으므로 함께 무시해도 정합성이 유지된다.
    let selfEditText: string | undefined;

    const replaceDocumentText = async (text: string): Promise<boolean> => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text);
      selfEditText = text;
      try {
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied && selfEditText === text) selfEditText = undefined;
        return applied;
      } catch (err) {
        if (selfEditText === text) selfEditText = undefined;
        throw err;
      }
    };

    // 저장 실패 공통 복원 (spec §4.3 경계 준용) — 파일 실제 상태로 문서·UI 정합 후 오류 알림.
    // 복원 자체가 실패하면(readFile·applyEdit 오류) 되돌림 성공을 단정하지 않고 별도 error 로
    // 표면화 — 이중 실패를 삼켜 UI·파일 불일치를 방치하지 않음. 어떤 경우에도 reject 하지 않아
    // 이 함수를 부르는 큐 스텝이 rejected 로 죽는 것을 차단 (리뷰).
    const restoreFromFile = async (saveErr: unknown): Promise<void> => {
      try {
        // 파일 실제 내용 기준 복원 — 문서를 파일 내용으로 되돌리고 그 내용을 UI 로 전달
        const fileBytes = await vscode.workspace.fs.readFile(document.uri);
        const fileText = new TextDecoder().decode(fileBytes);
        await replaceDocumentText(fileText);
        void webviewPanel.webview.postMessage({ type: "doc", text: fileText });
        // 되돌림 성공을 확인한 뒤에야 "되돌려졌다" 단정 (리뷰)
        void vscode.window.showErrorMessage(
          t(
            "Failed to save the .tasks file, so your last change was reverted: {0}",
            saveErr instanceof Error ? saveErr.message : String(saveErr),
          ),
        );
      } catch (restoreErr) {
        // 복원까지 실패 — 문서·파일·UI 가 어긋난 채 남음. 사실대로 error 표면화 (리뷰)
        void vscode.window.showErrorMessage(
          t(
            "Failed to save the .tasks file and could not revert it — the editor may be out of sync with the file on disk. Save error: {0}; revert error: {1}.",
            saveErr instanceof Error ? saveErr.message : String(saveErr),
            restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          ),
        );
      }
    };

    // 확정 조작 → 문서 전체 교체(WorkspaceEdit) → 즉시 저장 (spec §4.3·§3.1·§8).
    // 실패 시 오류 알림 + 파일 실제 상태로 문서·UI 복원 — UI·파일 불일치 방치 금지 (spec §4.3 경계).
    const applyLines = async (lines: TaskLine[]): Promise<void> => {
      try {
        if (!(await replaceDocumentText(serializeTaskLines(lines)))) {
          throw new Error("workspace edit was not applied");
        }
        if (!(await document.save())) throw new Error("document save failed");
        // 성공 시 문서 재전송 없음 — webview 는 확정 시점에 이미 같은 상태(낙관 갱신).
        // 에코가 뒤 조작의 기준 상태를 과거로 되돌리는 경합 차단 (spec §4.3 연속 확정).
      } catch (err) {
        await restoreFromFile(err);
      }
    };

    // undo/redo 결과 즉시 저장 (spec §4.5·§3.1) — dirty 방치 금지.
    const saveAfterHistory = async (): Promise<void> => {
      try {
        // save() 반환값은 "안 더러움"과 "실패"를 구분 못 함 — 저장 후 dirty 잔존으로 실패 판정.
        // (변경 이벤트 직후엔 dirty 플래그 갱신이 늦을 수 있어 선제 isDirty 검사 금지)
        await document.save();
        if (document.isDirty) throw new Error("document save failed");
      } catch (err) {
        await restoreFromFile(err);
      }
    };

    // 확정 처리 직렬화 — 연속 확정(수정 직후 이동 등)이 병행되면 저장 중 문서 교체가
    // 거부되어 뒤 확정이 실패 복원으로 유실됨. 도착 순서대로 완료 후 다음 처리 (spec §4.3 연속 확정).
    let applyQueue: Promise<void> = Promise.resolve();

    // 큐 스텝 실행기 — 한 스텝의 예외가 `.then` 체인을 rejected 로 만들어 이후 모든 저장·이력
    // 스텝이 조용히 멈추는 것을 차단. 예외는 여기서 흡수해 error 알림으로 표면화 (리뷰).
    const runStep = (step: () => Promise<unknown>): void => {
      applyQueue = applyQueue.then(step).then(
        () => undefined,
        (err: unknown) => {
          void vscode.window.showErrorMessage(
            t(
              "A .tasks editor operation failed: {0}",
              err instanceof Error ? err.message : String(err),
            ),
          );
        },
      );
    };

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(
      (message: WebviewMessage) => {
        if (message.type === "ready") {
          pushDocument();
          pushConfig();
        } else if (message.type === "apply") {
          runStep(() => applyLines(message.lines));
        } else if (message.type === "history") {
          // webview 가 잡은 Ctrl+Z/Y 위임 (spec §4.5) — 활성 커스텀 에디터의 문서 이력에 적용됨.
          // apply 와 같은 큐에 직렬화 — 편집 확정과 순서 보존, 저장 중 겹침 경합 방지 (spec §4.3 연속 확정, 리뷰).
          // executeCommand 는 reject 가능하므로 runStep 의 흡수로 큐 사망 방지 (리뷰).
          runStep(async () => {
            await vscode.commands.executeCommand(message.action);
          });
        } else if (message.type === "openAsText") {
          // 오류 화면 "Open as Text" — 기본 텍스트 에디터로 재열기 (spec §4.2 오류 안내)
          void vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
        }
      },
    );

    // 문서 변경 수신 (spec §4.5·§4.6):
    // - undo/redo(VS Code 문서 이력, spec §8) → UI 반영 + 즉시 저장 (spec §4.5).
    // - 그 외 사유 중 문서 전문이 마지막 자기 편집과 같으면 낙관 갱신 에코라 제외
    //   (spec §4.3·§4.6 이중 갱신 방지), 다르면 외부 변경 → 재파싱·목록 새로고침만 (저장 불필요).
    const changeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString()) return;
      const isHistory =
        event.reason === vscode.TextDocumentChangeReason.Undo ||
        event.reason === vscode.TextDocumentChangeReason.Redo;
      if (isHistory) {
        // undo/redo 로 문서가 자기편집 값에서 벗어나므로 에코 식별 기준을 폐기 —
        // 옛 저장값과 우연히 같은 외부 변경을 자기 에코로 오인해 무시하는 것 방지 (리뷰).
        selfEditText = undefined;
        pushDocument();
        runStep(() => saveAfterHistory());
        return;
      }
      if (event.document.getText() === selfEditText) return;
      selfEditText = undefined;
      pushDocument();
    });

    // editor.lineHeight 변경 시 즉시 재주입 — 설정 창에서 바꾸면 열린 에디터도 갱신 (spec §4.2).
    const configSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("editor.lineHeight")) pushConfig();
    });

    webviewPanel.onDidDispose(() => {
      if (activeTasksPanel === webviewPanel) activeTasksPanel = undefined;
      viewStateSubscription.dispose();
      messageSubscription.dispose();
      changeSubscription.dispose();
      configSubscription.dispose();
    });
  }
}

/** 새 .tasks 파일 생성·열기 (spec §4.8) — 설치 직후 진입로. */
async function newTasksFile(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder == null) {
    void vscode.window.showErrorMessage(t("Open a folder first to create a .tasks file."));
    return;
  }
  const inputName = await vscode.window.showInputBox({
    prompt: t("New .tasks file name"),
    value: "todo.tasks",
  });
  if (inputName == null || inputName.trim() === "") return;
  // 앞뒤 공백 제거 + `.tasks` 대소문자 무시 판정 — 입력과 다른 이름 생성·이중 확장자 방지 (리뷰).
  const trimmedName = inputName.trim();
  const fileName = /\.tasks$/i.test(trimmedName) ? trimmedName : `${trimmedName}.tasks`;
  const uri = vscode.Uri.joinPath(folder.uri, fileName);
  // 이미 있으면 내용을 건드리지 않고 그대로 열기 — 덮어쓰기 사고 차단.
  // stat 실패는 "진짜 없음(FileNotFound)"일 때만 생성으로 보고, 그 외 오류(권한·일시)는
  // 기존 파일을 빈 내용으로 덮어쓸 위험이 있어 만들지 않고 표면화 (리뷰).
  let exists: boolean;
  try {
    await vscode.workspace.fs.stat(uri);
    exists = true;
  } catch (err) {
    if (!(err instanceof vscode.FileSystemError) || err.code !== "FileNotFound") {
      void vscode.window.showErrorMessage(
        t(
          "Could not check whether the .tasks file already exists, so it was not created: {0}",
          err instanceof Error ? err.message : String(err),
        ),
      );
      return;
    }
    exists = false;
  }
  if (!exists) {
    await vscode.workspace.fs.writeFile(uri, new Uint8Array());
  }
  await vscode.commands.executeCommand("vscode.open", uri);
}

export function activate(context: vscode.ExtensionContext): void {
  setL10nBundle(vscode.l10n.bundle);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      "simplysm-tasks.editor",
      new TasksEditorProvider(context),
    ),
    vscode.commands.registerCommand("simplysm-tasks.new", () => newTasksFile()),
    // Ctrl+Z/Y 키바인딩 위임 (spec §4.5) — VS Code 가 webview 안 키를 선점하므로 키바인딩으로
    // 소유권을 가져와 webview 에 전달, webview 가 dirty 필드/문서 이력을 분기 (handleHistoryKey).
    vscode.commands.registerCommand(
      "simplysm-tasks.historyKey",
      (args: { action: "undo" | "redo" }) => {
        void activeTasksPanel?.webview.postMessage({ type: "historyKey", action: args.action });
      },
    ),
  );
}

export function deactivate(): void {}

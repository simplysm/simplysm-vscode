import * as vscode from "vscode";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";

// 확장 진입점 (spec 프로세스 1~2) — 창 포커스 복귀 시 열린 문서를 검사해
// non-dirty + 외부 변경 문서를 조용히 디스크 버전으로 리로드하고 탐색기를 갱신한다.
// 원본 스냅샷은 해시+메타 보관: 열기/저장 시점의 디스크 내용 sha1 과 mtime/size 를 기록,
// 포커스 복귀 시 stat 선비교로 무변경 파일의 read+hash 를 생략한다.

/** 문서 로드 시점 원본의 디스크 상태 — mtime/size 는 read 생략용 선비교 키. */
interface DiskState {
  readonly hash: string;
  readonly mtime: number;
  readonly size: number;
}

/** uri(문자열) → 문서 로드 시점 원본의 디스크 상태. */
const diskStates = new Map<string, DiskState>();

async function readDiskState(uri: vscode.Uri): Promise<DiskState | undefined> {
  try {
    const stat = await fs.stat(uri.fsPath);
    const bytes = await fs.readFile(uri.fsPath);
    return {
      hash: createHash("sha1").update(bytes).digest("hex"),
      mtime: stat.mtimeMs,
      size: stat.size,
    };
  } catch {
    // 디스크에서 삭제됨 등 — 읽을 수 없으면 비교 대상 아님 (삭제 처리는 VS Code 내장 소관)
    return undefined;
  }
}

async function recordDiskState(document: vscode.TextDocument): Promise<void> {
  if (document.uri.scheme !== "file") return;
  const state = await readDiskState(document.uri);
  if (state !== undefined) diskStates.set(document.uri.toString(), state);
}

/**
 * "Keep Editor Version" 선택 시점의 디스크 해시 — 같은 디스크 버전이면 재프롬프트하지 않고,
 * 디스크가 또 바뀌면 다시 묻는다 (spec 프로세스 3).
 */
const keepDecisions = new Map<string, string>();

/** 포커스 복귀 처리 중복 방지 — 처리 중(모달 대기 포함) 재진입하면 건너뛴다. */
let refreshing = false;

async function refreshOnFocus(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    // 검사 단계는 병렬 — 대부분의 복귀는 stat 선비교(무변경)에서 끝난다
    const changes = (
      await Promise.all(
        vscode.workspace.textDocuments.map(
          async (document): Promise<{ document: vscode.TextDocument; current: DiskState } | undefined> => {
            if (document.uri.scheme !== "file") return undefined;
            const key = document.uri.toString();
            const recorded = diskStates.get(key);
            if (recorded === undefined) return undefined;
            let stat;
            try {
              stat = await fs.stat(document.uri.fsPath);
            } catch {
              return undefined; // 삭제됨 등 — 비교 대상 아님
            }
            if (stat.mtimeMs === recorded.mtime && stat.size === recorded.size) return undefined;
            const current = await readDiskState(document.uri);
            if (current === undefined) return undefined;
            if (current.hash === recorded.hash) {
              // 내용 동일·메타만 변경(touch 등) — 갱신해 다음 복귀의 재읽기 방지
              diskStates.set(key, current);
              return undefined;
            }
            return { document, current };
          },
        ),
      )
    ).filter((change) => change !== undefined);

    const conflicts: { document: vscode.TextDocument; current: DiskState }[] = [];
    let changed = false;
    for (const { document, current } of changes) {
      changed = true;
      if (document.isDirty) {
        conflicts.push({ document, current });
      } else {
        // 조용한 리로드 — 알림 없음 (spec 프로세스 2)
        await vscode.commands.executeCommand("workbench.action.files.revert", document.uri);
        diskStates.set(document.uri.toString(), current);
      }
    }
    if (changed) {
      await vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
    }
    // 충돌 모달은 리로드·탐색기 갱신을 막지 않도록 뒤에 파일별 순차 표시
    for (const conflict of conflicts) {
      await promptConflict(conflict.document, conflict.current);
    }
  } finally {
    refreshing = false;
  }
}

/** 디스크 버전 가상 문서 스킴 — Show Diff 의 좌측(디스크)에 사용. */
const diskScheme = "simplysm-focus-refresh-disk";

async function promptConflict(
  document: vscode.TextDocument,
  current: DiskState,
): Promise<void> {
  const currentHash = current.hash;
  const key = document.uri.toString();
  if (keepDecisions.get(key) === currentHash) return;
  keepDecisions.delete(key);

  const fileName = document.uri.path.split("/").at(-1) ?? document.uri.path;
  const reloadItem = vscode.l10n.t("Reload from Disk");
  const keepItem = vscode.l10n.t("Keep Editor Version");
  const diffItem = vscode.l10n.t("Show Diff");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t('"{0}" has changed on disk.', fileName),
    {
      modal: true,
      detail: vscode.l10n.t(
        "The editor contains unsaved changes. Reloading from disk will discard them.",
      ),
    },
    reloadItem,
    keepItem,
    diffItem,
  );
  if (choice === reloadItem) {
    await vscode.commands.executeCommand("workbench.action.files.revert", document.uri);
    diskStates.set(key, current);
  } else if (choice === keepItem) {
    keepDecisions.set(key, currentHash);
  } else if (choice === diffItem) {
    // 결정 유보 상태로 diff 만 연다 — 다음 포커스 복귀 때 충돌이 남아 있으면 재표시 (spec 프로세스 3)
    // query 에 디스크 해시를 넣어 가상 문서 캐시가 옛 디스크 버전을 재사용하지 않게 한다
    const diskUri = document.uri.with({ scheme: diskScheme, query: currentHash });
    await vscode.commands.executeCommand(
      "vscode.diff",
      diskUri,
      document.uri,
      vscode.l10n.t("{0} (On Disk ↔ In Editor)", fileName),
    );
  }
  // Esc(undefined) = 결정 유보 — 다음 포커스 복귀 때 재표시 (spec 프로세스 3)
}

export function activate(context: vscode.ExtensionContext): void {
  // 활성화 시점에 이미 열려 있는 문서의 원본 해시 기록
  for (const document of vscode.workspace.textDocuments) {
    void recordDiskState(document);
  }

  let previousFocused = vscode.window.state.focused;
  context.subscriptions.push(
    // Show Diff 좌측: 그 시점의 디스크 내용을 직접 읽는 가상 문서 (plan 확정 결정)
    vscode.workspace.registerTextDocumentContentProvider(diskScheme, {
      async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const bytes = await fs.readFile(uri.with({ scheme: "file", query: "" }).fsPath);
        return new TextDecoder().decode(bytes);
      },
    }),
    vscode.workspace.onDidOpenTextDocument((document) => void recordDiskState(document)),
    vscode.workspace.onDidSaveTextDocument((document) => {
      // 저장 = 충돌 해소 — 유보/Keep 결정도 초기화
      keepDecisions.delete(document.uri.toString());
      void recordDiskState(document);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diskStates.delete(document.uri.toString());
      keepDecisions.delete(document.uri.toString());
    }),
    vscode.window.onDidChangeWindowState((windowState) => {
      const regained = !previousFocused && windowState.focused;
      previousFocused = windowState.focused;
      if (regained) {
        // 실패를 조용히 삼키지 않는다 — 리로드 실패는 낡은 내용으로 작업하게 되는 문제
        refreshOnFocus().catch((error: unknown) => {
          void vscode.window.showErrorMessage(
            vscode.l10n.t(
              "Focus Refresh failed to sync files: {0}",
              error instanceof Error ? error.message : String(error),
            ),
          );
        });
      }
    }),
  );
}

import * as vscode from "vscode";
import { hashOf } from "./storage.ts";
import { applyRestore, RestoreWriteError } from "./restore-apply.ts";
import { planRestore, restorePaths } from "./restore-plan.ts";
import { formatDateTime } from "./time-format.ts";
import type { ChangeRange, FileChange, HistoryScope } from "./history-changes.ts";
import type { Recorder } from "./recorder.ts";
import type { RestoreDisk } from "./restore-apply.ts";
import type { RestorePlan } from "./restore-plan.ts";
import type { Scanner } from "./scanner.ts";
import type { HistoryStore } from "./storage.ts";

// 복원 (spec 「4. 복원」) — 고른 파일을 고른 변경의 직전 상태로 놓는다. diff 의 왼쪽이 곧 복원 결과다.
// 복원이 만드는 파일 변경은 평소의 기록 경로(watcher)로 기록된다 — 그래서 복원도 복원할 수 있다.

/** 복원 중 — 목록의 복원 버튼을 감춘다(package.json 메뉴의 `when`). */
const restoringContextKey = "simplysm-local-history.restoring";

/** 복원 요청 — 고른 것을 푼 결과(diff 가 보이는 것과 같은 값). */
export interface RestoreRequest {
  readonly store: HistoryStore;
  /** 워크스페이스 폴더 — FileChange 의 경로는 이 폴더 기준이다. */
  readonly folderUri: vscode.Uri;
  readonly scopeKind: HistoryScope["kind"];
  /** 고른 변경의 범위 — 확인 창의 기준 시각은 범위 시작이다. */
  readonly range: ChangeRange;
  readonly changes: readonly FileChange[];
}

/** 복원 수행자 — 복원을 하나씩만 한다. */
export class Restorer {
  private readonly recorder: Recorder;
  private readonly scanner: Scanner;
  private readonly logger: vscode.LogOutputChannel;
  /** 복원 중 — 명령이 키 바인딩 등 버튼 밖의 경로로 들어와도 겹치지 않게 막는다. */
  private busy = false;

  constructor(recorder: Recorder, scanner: Scanner, logger: vscode.LogOutputChannel) {
    this.recorder = recorder;
    this.scanner = scanner;
    this.logger = logger;
  }

  /**
   * 복원한다 — 확인 창 → 진행 알림 → 완료 알림. 실패는 던진다(부른 쪽이 `showRestoreError` 로 알린다).
   * 쓰기가 도중에 실패하면 쓴 파일을 되돌린 뒤 던진다(`applyRestore`).
   * 다른 복원이 진행 중이면 아무것도 하지 않는다 — 근거(spec): 겹친 복원이 같은 파일을 번갈아 쓰면
   * 결과가 어느 변경의 직전 상태와도 맞지 않는다.
   */
  async restore(request: RestoreRequest): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.run(request);
    } finally {
      this.busy = false;
    }
  }

  private async run(request: RestoreRequest): Promise<void> {
    const scanned = this.scanner.scan(); // 스캔 트리거: 복원 실행 직전 (spec 스캔 트리거)
    const paths = restorePaths(request.changes, request.scopeKind);
    const uriOf = (entryPath: string) => vscode.Uri.joinPath(request.folderUri, entryPath);
    const current = new Map<string, string | null>();
    for (const entryPath of paths) {
      const content = await readContent(uriOf(entryPath));
      current.set(entryPath, content === undefined ? null : hashOf(content));
    }
    const unsaved = new Set(unsavedDocuments(paths, uriOf).keys());
    const plan = planRestore(request.changes, request.scopeKind, current, unsaved);
    const at = formatDateTime(request.range.fromAt);
    if (plan.fileCount === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Already in the state before the change at {0}.", at),
      );
      return;
    }
    if (!(await confirmRestore(plan, at))) return;

    await vscode.commands.executeCommand("setContext", restoringContextKey, true);
    let restored: number;
    try {
      restored = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t("Restoring {0} file(s)…", plan.fileCount),
        },
        async () => {
          // 스캔이 읽어 둔 옛 내용이 복원 뒤에 기록되지 않게, 스캔이 끝난 뒤 쓴다
          await scanned;
          return await this.apply(request, paths, uriOf);
        },
      );
    } finally {
      await vscode.commands.executeCommand("setContext", restoringContextKey, false);
    }
    void vscode.window.showInformationMessage(vscode.l10n.t("Restored {0} file(s).", restored));
  }

  /**
   * 안전장치 순서 (spec 「4. 복원」) — 1. 미저장 편집 저장, 2. 복원 직전 기록, 3. 복원.
   * 저장하지 않으면 그 편집이 이력에 남지 않고, 나중에 저장할 때 "디스크 파일이 더 최신" 충돌 창이 뜬다.
   * 저장한 문서는 복원이 디스크에 쓴 내용을 다시 읽어 보인다. 파일을 다 쓴 뒤 복원이 비게 만든 폴더를 지운다.
   * 반환 = 바뀐 파일 수.
   */
  private async apply(
    request: RestoreRequest,
    paths: readonly string[],
    uriOf: (entryPath: string) => vscode.Uri,
  ): Promise<number> {
    for (const [entryPath, document] of unsavedDocuments(paths, uriOf)) {
      if (!(await document.save())) throw new UnsavedEditsError(entryPath);
    }

    // 대상 파일 전부의 지금 상태를 스냅샷 하나로 — 마지막 기록과 같은 파일은 기록기가 뺀다
    const states: { path: string; hash: string | null; uri: vscode.Uri }[] = [];
    for (const entryPath of paths) {
      const uri = uriOf(entryPath);
      const content = await readContent(uri);
      const hash = content === undefined ? null : await request.store.saveBlob(content);
      states.push({ path: entryPath, hash, uri });
    }
    await this.recorder.recordNow(request.store, states);

    const before = new Map(states.map((state) => [state.path, state.hash]));
    const plan = planRestore(request.changes, request.scopeKind, before, new Set());
    await applyRestore(plan, before, workspaceDisk(request.store, uriOf), {
      // 되돌린 이름 변경은 기록에도 이름 변경으로 (spec 「3. 열람」 이름 변경은 항목 하나)
      link: (link, fromHash, toHash) => {
        this.recorder.linkRename(
          request.store,
          { path: link.from, hash: fromHash, uri: uriOf(link.from) },
          { path: link.to, hash: toHash, uri: uriOf(link.to) },
        );
      },
      warn: (message) => {
        this.logger.warn(message);
      },
    });
    return plan.fileCount;
  }
}

/** 미저장 편집을 저장하지 못했다 — 복원하지 않았다. 메시지가 곧 알림이다 (spec 「4. 복원」 확인 창). */
class UnsavedEditsError extends Error {
  constructor(entryPath: string) {
    super(vscode.l10n.t("Could not save unsaved edits of {0}.", entryPath));
  }
}

/** 알림에 적을 파일 목록 — 앞의 몇 개와 나머지 수. */
function pathSummary(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length <= 3 ? shown : vscode.l10n.t("{0} and {1} more", shown, paths.length - 3);
}

/**
 * 복원 실패 알림 (spec 「4. 복원」 진행과 완료).
 * - 미저장 편집 저장 실패: 그 문구.
 * - 쓰기 도중 실패 후 되돌리기도 실패: 되돌리지 못한 파일과 돌아가는 방법.
 * - 그 밖(쓰기 전 실패, 되돌리기까지 끝난 쓰기 실패): 원인과 "파일은 바뀌지 않았다".
 */
export function showRestoreError(error: unknown): void {
  if (error instanceof UnsavedEditsError) {
    void vscode.window.showErrorMessage(error.message);
    return;
  }
  const cause = error instanceof Error ? error.message : String(error);
  if (error instanceof RestoreWriteError && error.unrestored.length > 0) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "Local History failed to restore and could not put back {0}. The state just before this restore is recorded in Local History; restore the changes recorded after it to go back. Cause: {1}",
        pathSummary(error.unrestored),
        cause,
      ),
    );
    return;
  }
  void vscode.window.showErrorMessage(
    vscode.l10n.t("Local History failed to restore. No files were changed. Cause: {0}", cause),
  );
}

/** 복원이 쓰는 디스크 — vscode.workspace.fs. 파일 내용은 저장소의 blob 이다. */
function workspaceDisk(store: HistoryStore, uriOf: (entryPath: string) => vscode.Uri): RestoreDisk {
  const fs = vscode.workspace.fs;
  const notFound = (error: unknown) =>
    error instanceof vscode.FileSystemError && error.code === "FileNotFound";
  return {
    async writeFile(entryPath, hash) {
      const uri = uriOf(entryPath);
      const content = await store.readBlob(hash);
      // 지워진 폴더 아래의 파일을 되살리는 경우 — 부모 폴더를 먼저 만든다(있으면 그대로)
      await fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
      await fs.writeFile(uri, content);
    },
    async deleteFile(entryPath) {
      try {
        await fs.delete(uriOf(entryPath), { useTrash: false });
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    },
    async hashOf(entryPath) {
      const content = await readContent(uriOf(entryPath));
      return content === undefined ? null : hashOf(content);
    },
    async exists(entryPath) {
      try {
        await fs.stat(uriOf(entryPath));
        return true;
      } catch (error) {
        if (notFound(error)) return false;
        throw error;
      }
    },
    async removeFolderIfEmpty(entryPath) {
      const uri = uriOf(entryPath);
      try {
        if ((await fs.readDirectory(uri)).length > 0) return;
      } catch (error) {
        if (notFound(error)) return; // 이미 없다
        throw error;
      }
      // 비재귀 — 그 사이 뭔가 생겨도 내용을 지우지 않는다
      await fs.delete(uri, { recursive: false, useTrash: false });
    },
  };
}

/** 확인 창 (spec 「4. 복원」) — 바뀌는 파일 수 · 기준 시각 · 지워질 파일 · 폴더 밖 변경 · 미저장 편집 저장을 밝힌다. */
async function confirmRestore(plan: RestorePlan, at: string): Promise<boolean> {
  const details: string[] = [];
  if (plan.deletedCount > 0) {
    details.push(
      vscode.l10n.t(
        "{0} file(s) that did not exist before the change will be deleted.",
        plan.deletedCount,
      ),
    );
  }
  if (plan.outsideCount > 0) {
    details.push(
      vscode.l10n.t(
        "{0} file(s) moved across the folder boundary will be moved back, so paths outside the folder also change.",
        plan.outsideCount,
      ),
    );
  }
  if (plan.hasUnsaved) {
    details.push(vscode.l10n.t("Unsaved edits will be saved first and kept in Local History."));
  }
  const restoreButton = vscode.l10n.t("Restore");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t("Restore {0} file(s) to before the change at {1}?", plan.fileCount, at),
    { modal: true, detail: details.length === 0 ? undefined : details.join("\n") },
    restoreButton,
  );
  return choice === restoreButton;
}

/** 내용 — 없으면 undefined. 그 밖의 읽기 실패(권한 · 폴더 등)는 던진다. */
async function readContent(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return undefined;
    throw error;
  }
}

/** uri 비교 열쇠 — 디스크 경로는 Linux 에서만 대소문자를 가른다(VS Code 디스크 provider 와 같게). */
function uriKey(uri: vscode.Uri): string {
  const text = uri.toString();
  return process.platform === "linux" ? text : text.toLowerCase();
}

/** 대상 경로 중 미저장 편집이 있는 문서(텍스트 · 노트북) — 경로 → 문서. */
function unsavedDocuments(
  paths: readonly string[],
  uriOf: (entryPath: string) => vscode.Uri,
): Map<string, vscode.TextDocument | vscode.NotebookDocument> {
  const dirty = new Map<string, vscode.TextDocument | vscode.NotebookDocument>();
  for (const document of [
    ...vscode.workspace.textDocuments,
    ...vscode.workspace.notebookDocuments,
  ]) {
    if (document.isDirty && document.uri.scheme === "file")
      dirty.set(uriKey(document.uri), document);
  }
  const result = new Map<string, vscode.TextDocument | vscode.NotebookDocument>();
  for (const entryPath of paths) {
    const document = dirty.get(uriKey(uriOf(entryPath)));
    if (document !== undefined) result.set(entryPath, document);
  }
  return result;
}

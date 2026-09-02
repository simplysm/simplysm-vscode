import * as vscode from "vscode";
import { RETENTION_MS, WorkspaceStores } from "./storage.ts";
import { Excludes } from "./exclude.ts";
import { Recorder } from "./recorder.ts";
import { HistoryTreeProvider } from "./history-tree.ts";
import {
  openFolderChanges,
  openFolderRangeChanges,
  openSnapshotDiff,
  openSnapshotRangeDiff,
  registerHistoryContentProvider,
} from "./history-diff.ts";
import { rollbackFile, rollbackFolder } from "./rollback.ts";
import { Scanner } from "./scanner.ts";
import type { HistoryNode, HistoryTarget } from "./history-tree.ts";

// 확장 진입점 — 백그라운드 기록(Recorder) + Show History 시점 목록(TreeView)

/** 폴더 대상 트리의 변경 파일 항목 → 그 파일을 대상으로 한 HistoryTarget. */
function fileTargetOf(target: HistoryTarget, entryPath: string): HistoryTarget | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(target.uri);
  if (folder === undefined) return undefined;
  return {
    store: target.store,
    relPath: entryPath,
    uri: vscode.Uri.joinPath(folder.uri, entryPath),
    isFolder: false,
  };
}

/** deactivate 가 대기 중 기록을 마저 쓰기 위한 참조 — activate 에서 채운다. */
let active: { recorder: Recorder; stores: WorkspaceStores } | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const logger = vscode.window.createOutputChannel("Simplysm Local History", { log: true });
  const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const stores = new WorkspaceStores(context.globalStorageUri.fsPath, (error) => {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Local History failed to save its index: {0}", errorText(error)),
    );
  });
  const excludes = new Excludes();
  const recorder = new Recorder(stores, excludes, logger);
  active = { recorder, stores };
  const tree = new HistoryTreeProvider(logger);
  const treeView = vscode.window.createTreeView("simplysm-local-history.view", {
    treeDataProvider: tree,
    canSelectMany: true, // 범위선택 → 병합 diff
  });

  const scanner = new Scanner(stores, recorder, excludes, (error) => {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Local History failed to scan: {0}", errorText(error)),
    );
  });

  // 스캔 트리거 1: 기동 (spec 스캔 트리거)
  void scanner.scan();

  // 보존 기한 초과·제외 대상 정리 — 기동 시 백그라운드 (spec 저장 구조)
  void (async () => {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const resolved = await stores.resolve(folder.uri);
      if (resolved !== undefined) {
        await resolved.store.prune(Date.now() - RETENTION_MS, (entryPath) =>
          excludes.isExcluded(folder.uri, entryPath),
        );
      }
    }
  })().catch((error: unknown) => {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Local History failed to prune old history: {0}", errorText(error)),
    );
  });

  let previousFocused = vscode.window.state.focused;
  let previousSelection: readonly HistoryNode[] = []; // 비연속 선택 판별용 — 직전 선택과 비교해 새 클릭 항목을 찾는다
  let openAbort: AbortController | undefined; // 빠른 ↑↓ 탐색 — 마지막 선택만 diff 를 연다 (먼저 시작한 느린 열기가 뒤늦게 덮지 않게)
  context.subscriptions.push(
    // 스캔 트리거 2: 창 재포커스
    vscode.window.onDidChangeWindowState((windowState) => {
      const regained = !previousFocused && windowState.focused;
      previousFocused = windowState.focused;
      if (regained) void scanner.scan();
    }),
    logger,
    excludes,
    recorder,
    treeView,
    recorder.onDidRecord(() => tree.refresh()),
    registerHistoryContentProvider(stores),
    // 클릭·↑↓ 키보드 탐색 공통 경로 — 선택 시점의 diff 를 즉시 갱신 (spec 열람 흐름 2)
    // shift 범위선택(연속) = 구간 병합 diff. 띄엄띄엄 선택(ctrl)은 불허 — 마지막 클릭 항목 단일 선택으로 되돌린다
    // ("선택 시점들의 변경만 합치기"는 상태 비교 구조상 표현 불가라 오해를 만들기 때문)
    treeView.onDidChangeSelection((event) => {
      const node = event.selection[0];
      const target = tree.getTarget();
      const selection = event.selection;
      const added = selection.filter((candidate) => !previousSelection.includes(candidate));
      previousSelection = selection;
      if (node === undefined || target === undefined) return;
      openAbort?.abort();
      const signal = (openAbort = new AbortController()).signal;
      const open = async (): Promise<void> => {
        if (selection.length >= 2) {
          // 연속성 판정 — 선택된 고유 시각들이 루트 목록에서 빈틈없는 구간이어야 범위선택
          const selectedAts = [...new Set(selection.map((selected) => selected.snapshot.at))].sort(
            (a, b) => a - b,
          );
          const rootAts = (await tree.getChildren())
            .map((root) => root.snapshot.at)
            .sort((a, b) => a - b);
          const betweenCount =
            rootAts.indexOf(selectedAts.at(-1)!) - rootAts.indexOf(selectedAts[0]) + 1;
          if (signal.aborted) return;
          if (betweenCount !== selectedAts.length) {
            // 비연속 — 마지막 클릭 항목만 남긴다 (ctrl+클릭 = 일반 클릭과 동일하게)
            await treeView.reveal(added[0] ?? node, { select: true, focus: false });
            return;
          }
          const sorted = [...selection].sort((a, b) => a.snapshot.at - b.snapshot.at);
          const fromNode = sorted[0];
          const toNode = sorted.at(-1)!;
          if (target.isFolder) {
            await openFolderRangeChanges(target, fromNode.snapshot.at, toNode.snapshot.at, signal);
          } else {
            await openSnapshotRangeDiff(target, fromNode, toNode, signal);
          }
        } else if (node.kind === "entry") {
          const fileTarget = fileTargetOf(target, node.entry.path);
          if (fileTarget !== undefined) {
            await openSnapshotDiff(fileTarget, node.snapshot, undefined, signal);
          }
        } else if (target.isFolder) {
          await openFolderChanges(target, node.snapshot, signal);
        } else {
          await openSnapshotDiff(target, node.snapshot, node.pathAt, signal);
        }
      };
      open().catch((error: unknown) => {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Local History failed to open diff: {0}", errorText(error)),
        );
      });
    }),
    vscode.commands.registerCommand(
      "simplysm-local-history.rollback",
      async (node: HistoryNode) => {
        const target = tree.getTarget();
        if (target === undefined) return;
        void scanner.scan(); // 스캔 트리거 4: 롤백 직전
        try {
          let done: boolean;
          if (node.kind === "entry") {
            const fileTarget = fileTargetOf(target, node.entry.path);
            done = fileTarget !== undefined && (await rollbackFile(fileTarget, node.snapshot));
          } else if (target.isFolder) {
            done = await rollbackFolder(target, node.snapshot);
          } else {
            done = await rollbackFile(target, node.snapshot, node.pathAt);
          }
          if (done) tree.refresh();
        } catch (error) {
          void vscode.window.showErrorMessage(
            vscode.l10n.t("Local History failed to rollback: {0}", errorText(error)),
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      "simplysm-local-history.showHistory",
      async (uri?: vscode.Uri) => {
        void scanner.scan(); // 스캔 트리거 3: 열람 직전 — 기록 완료 시 목록이 자동 갱신된다
        // 탐색기 우클릭이면 uri 인자, 팔레트면 활성 에디터 대상
        const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (targetUri === undefined) {
          void vscode.window.showWarningMessage(
            vscode.l10n.t("Open a file to show its local history."),
          );
          return;
        }
        const resolved = await stores.resolve(targetUri);
        if (resolved === undefined) {
          void vscode.window.showWarningMessage(
            vscode.l10n.t("Local History is only available for files inside the workspace."),
          );
          return;
        }
        const stat = await vscode.workspace.fs.stat(targetUri);
        const isFolder = (stat.type & vscode.FileType.Directory) !== 0;
        await vscode.commands.executeCommand("setContext", "simplysm-local-history.active", true);
        tree.setTarget({ ...resolved, uri: targetUri, isFolder });
        treeView.description = resolved.relPath === "" ? "workspace" : resolved.relPath;
        await vscode.commands.executeCommand("simplysm-local-history.view.focus");
      },
    ),
  );
}

/** 종료·리로드 직전 debounce 창에 남은 변경과 색인을 마저 쓴다 — VS Code 가 이 Promise 를 기다린다(상한 5초). */
export async function deactivate(): Promise<void> {
  if (active === undefined) return;
  const { recorder, stores } = active;
  active = undefined;
  await recorder.flushNow();
  await stores.flushIndexes();
}

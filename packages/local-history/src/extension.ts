import * as vscode from "vscode";
import { RETENTION_MS, WorkspaceStores } from "./storage.ts";
import { Recorder } from "./recorder.ts";
import { HistoryTreeProvider } from "./history-tree.ts";
import { openFolderChanges, openSnapshotDiff, registerHistoryContentProvider } from "./history-diff.ts";
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

export function activate(context: vscode.ExtensionContext): void {
  const logger = vscode.window.createOutputChannel("Simplysm Local History", { log: true });
  const stores = new WorkspaceStores(context.globalStorageUri.fsPath);
  const recorder = new Recorder(stores, logger);
  const tree = new HistoryTreeProvider();
  const treeView = vscode.window.createTreeView("simplysm-local-history.view", {
    treeDataProvider: tree,
  });

  const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const scanner = new Scanner(stores, recorder, (error) => {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Local History failed to scan: {0}", errorText(error)),
    );
  });

  // 스캔 트리거 1: 기동 (spec 스캔 트리거)
  void scanner.scan();

  // 보존 기한 초과 정리 — 기동 시 백그라운드 (spec 저장 구조)
  void (async () => {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const resolved = await stores.resolve(folder.uri);
      if (resolved !== undefined) await resolved.store.prune(Date.now() - RETENTION_MS);
    }
  })().catch((error: unknown) => {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Local History failed to prune old history: {0}", errorText(error)),
    );
  });

  let previousFocused = vscode.window.state.focused;
  context.subscriptions.push(
    // 스캔 트리거 2: 창 재포커스
    vscode.window.onDidChangeWindowState((windowState) => {
      const regained = !previousFocused && windowState.focused;
      previousFocused = windowState.focused;
      if (regained) void scanner.scan();
    }),
    logger,
    recorder,
    treeView,
    recorder.onDidRecord(() => tree.refresh()),
    registerHistoryContentProvider(stores),
    // 클릭·↑↓ 키보드 탐색 공통 경로 — 선택 시점의 diff 를 즉시 갱신 (spec 열람 흐름 2)
    treeView.onDidChangeSelection((event) => {
      const node = event.selection[0];
      const target = tree.getTarget();
      if (node === undefined || target === undefined) return;
      const open = async (): Promise<void> => {
        if (node.kind === "entry") {
          const fileTarget = fileTargetOf(target, node.entry.path);
          if (fileTarget !== undefined) await openSnapshotDiff(fileTarget, node.snapshot);
        } else if (target.isFolder) {
          await openFolderChanges(target, node.snapshot);
        } else {
          await openSnapshotDiff(target, node.snapshot, node.pathAt);
        }
      };
      open().catch((error: unknown) => {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Local History failed to open diff: {0}", errorText(error)),
        );
      });
    }),
    vscode.commands.registerCommand("simplysm-local-history.rollback", async (node: HistoryNode) => {
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
    }),
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

import * as vscode from "vscode";
import os from "node:os";
import { RETENTION_MS, WorkspaceStores } from "./storage.ts";
import { CopyFolder } from "./default-app-copy.ts";
import { Excludes } from "./exclude.ts";
import { Recorder } from "./recorder.ts";
import { HistoryTreeProvider, scopeOf } from "./history-tree.ts";
import { openComparison, registerHistoryFileSystemProvider } from "./history-diff.ts";
import {
  changeSidesOf,
  rangeComparison,
  resolveRestoreTarget,
  resolveSelection,
} from "./history-selection.ts";
import { openInDefaultApp } from "./open-default-app.ts";
import { baseName } from "./rel-path.ts";
import { Restorer, showRestoreError } from "./restore.ts";
import { Scanner } from "./scanner.ts";
import type { HistoryNode, HistoryTarget } from "./history-tree.ts";
import type { SelectableNode } from "./history-selection.ts";
import type { ChangeSide } from "./open-default-app.ts";

// 확장 진입점 — 백그라운드 기록(Recorder) + Show History 변경 목록(TreeView)

/** 고를 수 있는 노드만 남긴다 — 더 보기는 클릭 명령만 가진 항목이다. */
function selectableOf(nodes: readonly HistoryNode[]): SelectableNode[] {
  return nodes.filter((node): node is SelectableNode => node.kind !== "more");
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
    canSelectMany: true, // 줄 범위 · 여러 항목 고르기 (spec 「3. 열람」 고르기와 diff)
  });
  /** 빈 목록 안내 (spec 「3. 열람」) — 제외 대상이면 그 이유를, 아니면 기록이 없음을 알린다. */
  const emptyMessageOf = (target: HistoryTarget): string => {
    if (!excludes.isExcluded(target.uri, target.relPath)) {
      return vscode.l10n.t("No changes recorded yet.");
    }
    return target.isFolder
      ? vscode.l10n.t("This folder is excluded from Local History.")
      : vscode.l10n.t("This file is excluded from Local History.");
  };

  const scanner = new Scanner(stores, recorder, excludes, logger, (error) => {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Local History failed to scan: {0}", errorText(error)),
    );
  });
  const restorer = new Restorer(recorder, scanner, logger);
  // 기본 앱으로 열 사본 — OS 임시 폴더 아래, 이 확장 호스트의 세션 폴더 (spec 「3. 열람」)
  const copies = new CopyFolder({ tempDir: os.tmpdir(), pid: process.pid, startedAt: Date.now() });

  // 스캔 트리거 1: 기동 (spec 스캔 트리거)
  void scanner.scan();

  // 지난 세션의 사본 정리 — 기동 시 백그라운드. 외부 앱이 잡고 있는 사본은 남겨 다음 기동에 다시 지운다.
  // 사용자가 할 일이 없어 실패는 로그만 남긴다.
  copies
    .removeStale((message) => {
      logger.warn(message);
    })
    .then(({ removed, held }) => {
      logger.debug(`default-app copies: removed ${removed}, kept ${held} held by other apps`);
    })
    .catch((error: unknown) => {
      logger.warn(`default-app copies: cleanup failed: ${errorText(error)}`);
    });

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
  // 직전 선택 — 마지막으로 클릭한 노드를 가린다. 대상이 바뀌면 쓰지 않는다(같은 at 의 줄이 다른 대상에도 있다)
  let previousSelection: { target: HistoryTarget; nodes: readonly SelectableNode[] } | undefined;
  let openAbort: AbortController | undefined; // 빠르게 옮겨 고르면 마지막 선택만 diff 를 연다 (먼저 시작한 느린 열기가 뒤늦게 덮지 않게)
  /**
   * 우클릭 메뉴 "기본 앱으로 열기" (spec 「3. 열람」) — 누른 노드(파일 이력의 줄, 폴더 이력의 파일 항목) 하나의
   * 직전 또는 직후. 양쪽은 그 노드의 diff 와 같은 값이다(`changeSidesOf`).
   */
  const openSideInDefaultApp =
    (side: ChangeSide) =>
    async (node?: HistoryNode): Promise<void> => {
      const target = tree.getTarget();
      if (target === undefined || node === undefined) return;
      if (node.kind !== "row" && node.kind !== "file") return;
      const sides = changeSidesOf(node);
      if (sides === undefined) return; // 폴더 이력의 줄 — 메뉴에 없다
      try {
        await openInDefaultApp(copies, target.store, sides, side);
      } catch (error) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Local History failed to open in the default app: {0}", errorText(error)),
        );
      }
    };
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
    tree.onDidLoadRows(({ target, empty }) => {
      if (target !== tree.getTarget()) return;
      treeView.message = empty ? emptyMessageOf(target) : undefined;
    }),
    registerHistoryFileSystemProvider(stores),
    // 선택이 바뀌는 모든 조작(클릭 · Shift/Ctrl 클릭 · Shift+↑↓ · Enter)의 공통 경로 — 고른 것의 직전 ↔ 직후
    // diff 를 즉시 연다 (spec 「3. 열람」 고르기와 diff). 허용하지 않는 선택(비연속 줄, 줄과 선택되지 않은
    // 다른 줄의 항목, 다른 줄들의 항목)은 마지막 클릭 노드 하나로 되돌린다 — 되돌린 선택이 다시 이 경로로
    // 들어와 그 diff 를 연다.
    treeView.onDidChangeSelection((event) => {
      const target = tree.getTarget();
      const selection = selectableOf(event.selection);
      if (target === undefined) return;
      const previous =
        previousSelection !== undefined && previousSelection.target === target
          ? previousSelection.nodes
          : [];
      previousSelection = { target, nodes: selection };
      const folder = vscode.workspace.getWorkspaceFolder(target.uri);
      if (folder === undefined) return;
      const targetName = target.relPath === "" ? folder.name : baseName(target.relPath);
      const result = resolveSelection(
        selection,
        previous,
        tree.getLoadedRows().map((row) => row.snapshot.at),
        targetName,
      );
      if (result === undefined) return;
      openAbort?.abort();
      const signal = (openAbort = new AbortController()).signal;
      const open = async (): Promise<void> => {
        if (result.kind === "reselect") {
          await treeView.reveal(result.node, { select: true, focus: false });
          return;
        }
        const comparison =
          result.kind === "items"
            ? result.comparison
            : rangeComparison(
                await target.store.listSnapshots(),
                scopeOf(target),
                targetName,
                result.range,
              );
        if (signal.aborted) return; // 더 늦게 고른 것이 있다
        await openComparison(folder.uri, comparison);
      };
      open().catch((error: unknown) => {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Local History failed to open diff: {0}", errorText(error)),
        );
      });
    }),
    // 줄 · 항목의 복원 버튼 (spec 「4. 복원」) — VS Code 는 누른 노드와, 그 노드가 여러 개의 선택에 들면
    // 선택 전부를 넘긴다. 복원 대상과 파일별 결과는 diff 와 같은 값(`resolveSelection` → FileChange)이다.
    vscode.commands.registerCommand(
      "simplysm-local-history.restore",
      async (node?: HistoryNode, selected?: readonly HistoryNode[]) => {
        const target = tree.getTarget();
        if (target === undefined || node === undefined || node.kind === "more") return;
        const folder = vscode.workspace.getWorkspaceFolder(target.uri);
        if (folder === undefined) return;
        const targetName = target.relPath === "" ? folder.name : baseName(target.relPath);
        const scope = scopeOf(target);
        const restoreTarget = resolveRestoreTarget(
          node,
          selectableOf(selected ?? []),
          tree.getLoadedRows().map((row) => row.snapshot.at),
          targetName,
        );
        try {
          const comparison =
            restoreTarget.kind === "items"
              ? restoreTarget.comparison
              : rangeComparison(
                  await target.store.listSnapshots(),
                  scope,
                  targetName,
                  restoreTarget.range,
                );
          await restorer.restore({
            store: target.store,
            folderUri: folder.uri,
            scopeKind: scope.kind,
            range: comparison.range,
            changes: comparison.changes,
          });
        } catch (error) {
          showRestoreError(error);
        }
      },
    ),
    vscode.commands.registerCommand(
      "simplysm-local-history.openBeforeInDefaultApp",
      openSideInDefaultApp("before"),
    ),
    vscode.commands.registerCommand(
      "simplysm-local-history.openAfterInDefaultApp",
      openSideInDefaultApp("after"),
    ),
    vscode.commands.registerCommand("simplysm-local-history.loadMore", async () => {
      try {
        await tree.loadMore();
      } catch (error) {
        void vscode.window.showErrorMessage(
          vscode.l10n.t("Local History failed to load more history: {0}", errorText(error)),
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

/** 종료·리로드 직전 debounce 창에 남은 변경과 색인을 마저 쓴다 — VS Code 가 이 Promise 를 기다린다(상한 5초). */
export async function deactivate(): Promise<void> {
  if (active === undefined) return;
  const { recorder, stores } = active;
  active = undefined;
  await recorder.flushNow();
  await stores.flushIndexes();
}

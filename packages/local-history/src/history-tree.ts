import * as vscode from "vscode";
import { isUnderPrefix } from "./storage.ts";
import type { ResolvedTarget, Snapshot, SnapshotEntry } from "./storage.ts";

/** Show History 대상 — 파일/폴더 공통. */
export interface HistoryTarget extends ResolvedTarget {
  readonly uri: vscode.Uri;
  readonly isFolder: boolean;
}

/** 트리 노드 — 시점(폴더 대상이면 하위에 그 시점의 변경 파일 목록). `pathAt` = 그 시점의 파일 경로(rename 체인). */
export type HistoryNode =
  | { readonly kind: "snapshot"; readonly snapshot: Snapshot; readonly pathAt?: string }
  | { readonly kind: "entry"; readonly snapshot: Snapshot; readonly entry: SnapshotEntry };

/** Show History 대상의 시점 목록 TreeView (spec UI — 시점 = 시각 라벨). */
export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryNode> {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;
  private target: HistoryTarget | undefined;
  private readonly logger: vscode.LogOutputChannel;

  constructor(logger: vscode.LogOutputChannel) {
    this.logger = logger;
  }

  setTarget(target: HistoryTarget): void {
    this.target = target;
    this.logger.debug(`tree setTarget: ${target.relPath} (folder=${target.isFolder})`);
    this.onDidChangeEmitter.fire();
  }

  getTarget(): HistoryTarget | undefined {
    return this.target;
  }

  refresh(): void {
    this.logger.debug("tree refresh");
    this.onDidChangeEmitter.fire();
  }

  private entriesOf(target: HistoryTarget, snapshot: Snapshot): SnapshotEntry[] {
    return target.isFolder
      ? snapshot.entries.filter((entry) => isUnderPrefix(entry.path, target.relPath))
      : snapshot.entries.filter((entry) => entry.path === target.relPath);
  }

  async getChildren(element?: HistoryNode): Promise<HistoryNode[]> {
    const target = this.target;
    if (target === undefined) {
      this.logger.debug("tree getChildren: target 없음 → []");
      return [];
    }
    if (element === undefined) {
      if (target.isFolder) {
        const snapshots = await target.store.listSnapshots();
        const roots = snapshots
          .filter((snapshot) => this.entriesOf(target, snapshot).length > 0)
          .map((snapshot) => ({ kind: "snapshot" as const, snapshot }));
        this.logger.debug(`tree getChildren(root, folder): ${roots.length}개`);
        return roots;
      }
      // 파일 대상 — rename 체인을 따라 과거 경로 이력까지 나열
      const refs = await target.store.listFileSnapshots(target.relPath);
      this.logger.debug(`tree getChildren(root, file=${target.relPath}): ${refs.length}개`);
      return refs.map((ref) => ({ kind: "snapshot", snapshot: ref.snapshot, pathAt: ref.path }));
    }
    if (element.kind === "snapshot" && target.isFolder) {
      return this.entriesOf(target, element.snapshot).map((entry) => ({
        kind: "entry",
        snapshot: element.snapshot,
        entry,
      }));
    }
    return [];
  }

  /** reveal(선택 재설정)용 부모 해석 — id 기반 매칭이라 새 노드 객체여도 동작. */
  getParent(node: HistoryNode): HistoryNode | undefined {
    return node.kind === "entry" ? { kind: "snapshot", snapshot: node.snapshot } : undefined;
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    const target = this.target;
    if (node.kind === "snapshot") {
      const item = new vscode.TreeItem(
        new Date(node.snapshot.at).toLocaleString(),
        target?.isFolder === true
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      item.id = `${node.snapshot.at}`;
      item.contextValue = "snapshot";
      if (target?.isFolder === true) {
        const count = this.entriesOf(target, node.snapshot).length;
        item.description = count === 1 ? vscode.l10n.t("1 file") : vscode.l10n.t("{0} files", count);
      }
      return item;
    }
    // 변경 파일 항목 — 라벨은 대상 폴더 기준 상대 경로, 아이콘은 리소스 테마
    const prefix = target === undefined || target.relPath === "" ? "" : `${target.relPath}/`;
    const label = node.entry.path.startsWith(prefix)
      ? node.entry.path.slice(prefix.length)
      : node.entry.path;
    const item = new vscode.TreeItem(label);
    item.id = `${node.snapshot.at}:${node.entry.path}`;
    item.contextValue = "entry";
    if (target !== undefined) {
      const folder = vscode.workspace.getWorkspaceFolder(target.uri);
      if (folder !== undefined) {
        item.resourceUri = vscode.Uri.joinPath(folder.uri, node.entry.path);
      }
    }
    if (node.entry.hash === null) item.description = vscode.l10n.t("deleted");
    return item;
  }
}

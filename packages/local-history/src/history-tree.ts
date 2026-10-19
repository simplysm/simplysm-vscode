import * as vscode from "vscode";
import { computeChanges, listRows } from "./history-changes.ts";
import { historyScheme } from "./history-diff.ts";
import { contextValueOf } from "./history-selection.ts";
import { baseName, compareTreeOrder, parentPath } from "./rel-path.ts";
import { formatDateTime, formatTime, isSameDay } from "./time-format.ts";
import type { FileChange, HistoryScope } from "./history-changes.ts";
import type { ResolvedTarget, Snapshot } from "./storage.ts";

/** Show History 대상 — 파일/폴더 공통. */
export interface HistoryTarget extends ResolvedTarget {
  readonly uri: vscode.Uri;
  readonly isFolder: boolean;
}

/** 목록을 나눠 읽는 단위 (spec 「3. 열람」 — 100줄씩, "더 보기"로 잇는다). */
const PAGE_SIZE = 100;

/** 변경 목록의 줄 — 변경(스냅샷) 하나. `pathAt` = 그 줄에서 대상 파일의 경로(파일 이력만, rename 체인). */
export interface RowNode {
  readonly kind: "row";
  readonly snapshot: Snapshot;
  readonly pathAt?: string;
  /** 이 변경의 직전 ↔ 직후 (탐색기 순서). 파일 이력은 0~1개. */
  readonly changes: readonly FileChange[];
  /** 위 줄과 날짜가 다르다 — 라벨에 날짜를 적는다. */
  readonly showDate: boolean;
}

/** 폴더 이력의 줄 아래 폴더 항목 — `path` = 워크스페이스 폴더 기준 폴더 경로. */
export interface FolderNode {
  readonly kind: "folder";
  readonly row: RowNode;
  readonly parent: RowNode | FolderNode;
  readonly path: string;
  readonly children: readonly (FolderNode | FileNode)[];
}

/** 폴더 이력의 줄 아래 파일 항목 — 바뀐 파일 하나. */
export interface FileNode {
  readonly kind: "file";
  readonly row: RowNode;
  readonly parent: RowNode | FolderNode;
  readonly change: FileChange;
}

/** 목록 끝의 "더 보기" — 고르면 다음 100줄을 붙인다. */
export interface MoreNode {
  readonly kind: "more";
}

/** 트리 노드 — 줄 · 폴더 항목 · 파일 항목 · 더 보기 (plan 「설계 결정」). */
export type HistoryNode = RowNode | FolderNode | FileNode | MoreNode;

/** 루트 목록을 읽은 결과 — 빈 목록 안내(`TreeView.message`)를 정하는 쪽에 알린다. */
export interface RowsLoadedEvent {
  readonly target: HistoryTarget;
  readonly empty: boolean;
}

/**
 * 이름 변경의 설명 글자 — 폴더 밖으로 나간 이동은 새 경로, 그 밖에는 옛 경로를 적는다.
 * 경로 표기: 같은 폴더 안이면 이름만, 다른 폴더와의 이동이면 워크스페이스 기준 경로.
 */
function renamedText(change: FileChange): string {
  const other = change.outside === "after" ? change.afterPath : change.beforePath;
  const shown =
    parentPath(change.beforePath) === parentPath(change.afterPath) ? baseName(other) : other;
  return change.outside === "after"
    ? vscode.l10n.t("moved to {0}", shown)
    : vscode.l10n.t("renamed from {0}", shown);
}

/** 파일 항목의 설명 글자 — 변경 종류 (spec 「3. 열람」 폴더 이력의 줄 아래). */
function kindText(change: FileChange): string {
  switch (change.kind) {
    case "added":
      return vscode.l10n.t("added");
    case "deleted":
      return vscode.l10n.t("deleted");
    case "modified":
      return vscode.l10n.t("modified");
    case "renamed":
      return renamedText(change);
  }
}

/** 과거 내용 scheme 의 uri — 항목 아이콘을 파일 아이콘 테마에서 고르되, 실제 파일 uri 가 아니라서 git 등의 파일 장식이 붙지 않는다. */
function iconUriOf(target: HistoryTarget, entryPath: string): vscode.Uri | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(target.uri);
  return folder === undefined
    ? undefined
    : vscode.Uri.joinPath(folder.uri, entryPath).with({ scheme: historyScheme });
}

export function scopeOf(target: HistoryTarget): HistoryScope {
  return { kind: target.isFolder ? "folder" : "file", path: target.relPath };
}

/** 폴더 이력 줄의 아래 — 바뀜 파일을 폴더 트리로. `changes` 는 탐색기 순서로 정렬돼 있다. */
function buildLevel(
  row: RowNode,
  parent: RowNode | FolderNode,
  folderPath: string,
  changes: readonly FileChange[],
): (FolderNode | FileNode)[] {
  const files: FileNode[] = [];
  const folders = new Map<string, FileChange[]>(); // 하위 폴더 이름 → 그 아래 변경 (정렬 순서 유지)
  for (const change of changes) {
    const rest = folderPath === "" ? change.path : change.path.slice(folderPath.length + 1);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      files.push({ kind: "file", row, parent, change });
      continue;
    }
    const name = rest.slice(0, slash);
    const inFolder = folders.get(name);
    if (inFolder === undefined) folders.set(name, [change]);
    else inFolder.push(change);
  }
  const folderNodes = [...folders].map(([name, inFolder]) => {
    const node: { -readonly [K in keyof FolderNode]: FolderNode[K] } = {
      kind: "folder",
      row,
      parent,
      path: folderPath === "" ? name : `${folderPath}/${name}`,
      children: [],
    };
    node.children = buildLevel(row, node, node.path, inFolder);
    return node;
  });
  return [...folderNodes, ...files];
}

/** Show History 대상의 변경 목록 TreeView (spec 「3. 열람」 변경 목록). */
export class HistoryTreeProvider implements vscode.TreeDataProvider<HistoryNode> {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeEmitter.event;
  private readonly rowsLoadedEmitter = new vscode.EventEmitter<RowsLoadedEvent>();
  readonly onDidLoadRows = this.rowsLoadedEmitter.event;
  private target: HistoryTarget | undefined;
  /**
   * 불러온 줄의 하한 — 이 at 이상인 줄을 보인다. 개수가 아니라 시각으로 두어 새 기록이 위에 붙어도
   * 불러온 줄이 밀려나지 않는다. null = 끝까지, undefined = 첫 쪽을 아직 정하지 않음.
   */
  private loadedFromAt: number | null | undefined;
  /** 마지막으로 낸 줄 목록(최신순) — 선택의 연속성 판정이 쓴다. */
  private rows: readonly RowNode[] = [];
  private readonly logger: vscode.LogOutputChannel;

  constructor(logger: vscode.LogOutputChannel) {
    this.logger = logger;
  }

  setTarget(target: HistoryTarget): void {
    this.target = target;
    this.loadedFromAt = undefined;
    this.rows = [];
    this.logger.debug(`tree setTarget: ${target.relPath} (folder=${target.isFolder})`);
    this.onDidChangeEmitter.fire();
  }

  getLoadedRows(): readonly RowNode[] {
    return this.rows;
  }

  /** 다음 100줄을 붙인다 ("더 보기"). */
  async loadMore(): Promise<void> {
    const target = this.target;
    if (target === undefined) return;
    const rows = listRows(await target.store.listSnapshots(), scopeOf(target));
    const fromAt = this.loadedFromAt;
    if (target !== this.target || fromAt === undefined || fromAt === null) return;
    const loadedCount = rows.findIndex((row) => row.snapshot.at < fromAt);
    if (loadedCount < 0) return; // 이미 끝까지 보인다
    const lastIndex = loadedCount + PAGE_SIZE - 1;
    this.loadedFromAt = lastIndex >= rows.length - 1 ? null : rows[lastIndex].snapshot.at;
    this.logger.debug(`tree loadMore: ${loadedCount} → ${Math.min(lastIndex + 1, rows.length)}`);
    this.onDidChangeEmitter.fire();
  }

  getTarget(): HistoryTarget | undefined {
    return this.target;
  }

  refresh(): void {
    this.logger.debug("tree refresh");
    this.onDidChangeEmitter.fire();
  }

  async getChildren(element?: HistoryNode): Promise<HistoryNode[]> {
    const target = this.target;
    if (target === undefined) {
      this.logger.debug("tree getChildren: target 없음 → []");
      return [];
    }
    if (element === undefined) return await this.loadRows(target);
    if (element.kind === "row" && target.isFolder) {
      return buildLevel(element, element, target.relPath, element.changes);
    }
    if (element.kind === "folder") return [...element.children];
    return [];
  }

  /** 루트 — 불러온 줄 + (남은 줄이 있으면) 더 보기. */
  private async loadRows(target: HistoryTarget): Promise<HistoryNode[]> {
    const snapshots = await target.store.listSnapshots();
    if (target !== this.target) return []; // 읽는 사이 대상이 바뀜 — 새 대상의 갱신이 따로 온다
    const scope = scopeOf(target);
    const allRows = listRows(snapshots, scope);
    if (this.loadedFromAt === undefined) {
      // 첫 쪽 — 최신 100줄. null(끝까지)은 정해진 값이다 — `??=` 는 null 도 덮어쓰므로 쓰지 않는다
      this.loadedFromAt = allRows.length > PAGE_SIZE ? allRows[PAGE_SIZE - 1].snapshot.at : null;
    }
    const fromAt = this.loadedFromAt;
    const visible = fromAt === null ? allRows : allRows.filter((row) => row.snapshot.at >= fromAt);
    const changes = computeChanges(
      snapshots,
      scope,
      visible.map((row) => ({ fromAt: row.snapshot.at, toAt: row.snapshot.at })),
    );
    const rows = visible.map(
      (row, index): RowNode => ({
        kind: "row",
        snapshot: row.snapshot,
        pathAt: row.pathAt,
        changes: changes[index].toSorted((a, b) => compareTreeOrder(a.path, b.path)),
        showDate: index === 0 || !isSameDay(visible[index - 1].snapshot.at, row.snapshot.at),
      }),
    );
    this.rows = rows;
    this.logger.debug(
      `tree getChildren(root, ${target.relPath}): ${rows.length}/${allRows.length}줄`,
    );
    this.rowsLoadedEmitter.fire({ target, empty: rows.length === 0 });
    return rows.length < allRows.length ? [...rows, { kind: "more" }] : rows;
  }

  /** reveal(선택 재설정)용 부모 해석. */
  getParent(node: HistoryNode): HistoryNode | undefined {
    return node.kind === "folder" || node.kind === "file" ? node.parent : undefined;
  }

  getTreeItem(node: HistoryNode): vscode.TreeItem {
    const target = this.target!; // 노드는 대상이 있을 때만 만든다
    const idBase = `${target.uri.toString()}#`; // 대상을 바꾸면 이전 대상의 선택이 같은 at 의 줄로 옮겨 가지 않게
    switch (node.kind) {
      case "row":
        return this.rowItem(target, idBase, node);
      case "folder": {
        const item = new vscode.TreeItem(
          baseName(node.path),
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `${idBase}${node.row.snapshot.at}#${node.path}/`;
        item.contextValue = contextValueOf(node);
        item.iconPath = vscode.ThemeIcon.Folder;
        item.resourceUri = iconUriOf(target, node.path);
        return item;
      }
      case "file": {
        const item = new vscode.TreeItem(baseName(node.change.path));
        item.id = `${idBase}${node.row.snapshot.at}#${node.change.path}`;
        item.contextValue = contextValueOf(node); // 기본 앱으로 열 직전 · 직후 유무 포함
        item.iconPath = vscode.ThemeIcon.File;
        item.resourceUri = iconUriOf(target, node.change.path);
        item.description = kindText(node.change);
        item.tooltip = node.change.path;
        return item;
      }
      case "more": {
        const item = new vscode.TreeItem(vscode.l10n.t("Load more…"));
        item.id = `${idBase}more`;
        item.contextValue = "more";
        item.command = {
          command: "simplysm-local-history.loadMore",
          title: vscode.l10n.t("Load more…"),
        };
        return item;
      }
    }
  }

  /**
   * 줄 라벨 (spec 「3. 열람」 변경 목록) — 시각은 초까지, 위 줄과 같은 날이면 시각만.
   * 설명 글자: 폴더 이력은 바뀐 파일 요약, 파일 이력은 이름 변경 줄의 옛 경로.
   */
  private rowItem(target: HistoryTarget, idBase: string, node: RowNode): vscode.TreeItem {
    const at = node.snapshot.at;
    const hasChildren = target.isFolder && node.changes.length > 0;
    const item = new vscode.TreeItem(
      node.showDate ? formatDateTime(at) : formatTime(at),
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `${idBase}${node.snapshot.at}`;
    item.contextValue = contextValueOf(node); // 파일 이력은 기본 앱으로 열 직전 · 직후 유무 포함
    item.tooltip = formatDateTime(at);
    if (target.isFolder) {
      const first = node.changes[0];
      if (first !== undefined) {
        const name = baseName(first.path);
        item.description =
          node.changes.length === 1
            ? name
            : vscode.l10n.t("{0} and {1} more", name, node.changes.length - 1);
      }
    } else if (node.changes[0]?.kind === "renamed") {
      item.description = renamedText(node.changes[0]);
    }
    return item;
  }
}

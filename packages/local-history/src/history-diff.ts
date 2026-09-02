import * as vscode from "vscode";
import { hashOf } from "./storage.ts";
import type { ResolvedTarget, Snapshot, WorkspaceStores } from "./storage.ts";

/** 시점 blob 을 공급하는 가상 문서 스킴 (spec UI — diff = 내장 에디터). */
const historyScheme = "simplysm-local-history";

/** diff 열람 크기 상한 — 초과 파일은 기록·롤백은 그대로 두고 내용 diff 만 막는다. */
const MAX_DIFF_SIZE = 10 * 1024 * 1024;

/**
 * 시점 내용 가상 문서 uri — path 는 언어 감지·제목용, query 로 원본 파일과 blob 해시 전달.
 * `placeholder` = 대용량 파일의 diff 자리 텍스트 (side 는 좌·우 문서를 분리하는 표식).
 */
function buildHistoryUri(
  fileUri: vscode.Uri,
  relPath: string,
  hash: string | null,
  placeholder?: "snapshot" | "current",
): vscode.Uri {
  return vscode.Uri.from({
    scheme: historyScheme,
    path: `/${relPath}`,
    query: new URLSearchParams({
      file: fileUri.toString(),
      hash: hash ?? "",
      ...(placeholder === undefined ? {} : { placeholder }),
    }).toString(),
  });
}

export function registerHistoryContentProvider(stores: WorkspaceStores): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(historyScheme, {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      const params = new URLSearchParams(uri.query);
      if (params.get("placeholder") !== null) {
        // 대용량 파일 — 내용 대신 안내 텍스트 (양쪽 동일 → 변경 없음으로 표시)
        return vscode.l10n.t("File is too large to show diff. Use rollback to restore it.");
      }
      const hash = params.get("hash");
      if (hash === null || hash === "") return ""; // 그 시점에 삭제된 파일
      const fileUri = vscode.Uri.parse(params.get("file") ?? "");
      const resolved = await stores.resolve(fileUri);
      if (resolved === undefined) {
        throw new Error(`Cannot resolve history store for: ${fileUri.toString()}`);
      }
      return new TextDecoder().decode(await resolved.store.readBlob(hash));
    },
  });
}

/**
 * 시점 선택 → 내장 diff (좌: 시점, 우: 현재) — 목록 ↑↓ 탐색을 막지 않게 preserveFocus.
 * `entryPath` = 그 시점의 파일 경로 (rename 체인, 기본 = 현재 경로).
 */
export async function openSnapshotDiff(
  target: ResolvedTarget & { readonly uri: vscode.Uri },
  snapshot: Snapshot,
  entryPath: string = target.relPath,
  signal?: AbortSignal,
): Promise<void> {
  const entry = snapshot.entries.find((snapshotEntry) => snapshotEntry.path === entryPath);
  if (entry === undefined) return;
  // 대용량은 diff 를 열지 않는다 — 내용 로드로 에디터가 멈추는 것 방지 (기록·롤백은 크기 무관)
  let currentSize = 0;
  try {
    currentSize = (await vscode.workspace.fs.stat(target.uri)).size;
  } catch {
    // 현재 파일 없음 — 크기 0 취급
  }
  const snapshotSize = entry.hash === null ? 0 : await target.store.blobSize(entry.hash);
  if (signal?.aborted === true) return;
  if (currentSize > MAX_DIFF_SIZE || snapshotSize > MAX_DIFF_SIZE) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("File is too large to show diff. Use rollback to restore it."),
    );
    return;
  }
  const fileName = target.relPath.split("/").at(-1) ?? target.relPath;
  await vscode.commands.executeCommand(
    "vscode.diff",
    buildHistoryUri(target.uri, entryPath, entry.hash),
    target.uri,
    vscode.l10n.t("{0} ({1} ↔ Current)", fileName, new Date(snapshot.at).toLocaleString()),
    { preview: true, preserveFocus: true },
  );
}

/**
 * 파일 시점 범위선택 → 병합 diff (좌: 범위 시작 직전 상태, 우: 범위 끝 시점) — 중간 시점은 흡수된다.
 * rename 체인 고려 — 좌·우 각각 그 시점의 경로로 blob 을 찾는다.
 */
export async function openSnapshotRangeDiff(
  target: ResolvedTarget & { readonly uri: vscode.Uri },
  fromNode: { readonly snapshot: Snapshot; readonly pathAt?: string },
  toNode: { readonly snapshot: Snapshot; readonly pathAt?: string },
  signal?: AbortSignal,
): Promise<void> {
  const toPath = toNode.pathAt ?? target.relPath;
  const toEntry = toNode.snapshot.entries.find((entry) => entry.path === toPath);
  if (toEntry === undefined) return;
  // 범위 시작 "직전" 시점 — rename 체인 목록에서 시작 시점보다 오래된 첫 항목 (없으면 기록 이전 = 빈 문서)
  const refs = await target.store.listFileSnapshots(target.relPath);
  const prevRef = refs.find((ref) => ref.snapshot.at < fromNode.snapshot.at);
  const fromHash =
    prevRef === undefined
      ? null
      : (prevRef.snapshot.entries.find((entry) => entry.path === prevRef.path)?.hash ?? null);
  const fromPath = prevRef?.path ?? fromNode.pathAt ?? target.relPath;
  // 대용량은 diff 를 열지 않는다 — 양쪽 모두 blob 크기로 판정 (기록·롤백은 크기 무관)
  const fromSize = fromHash === null ? 0 : await target.store.blobSize(fromHash);
  const toSize = toEntry.hash === null ? 0 : await target.store.blobSize(toEntry.hash);
  if (signal?.aborted === true) return;
  if (fromSize > MAX_DIFF_SIZE || toSize > MAX_DIFF_SIZE) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("File is too large to show diff. Use rollback to restore it."),
    );
    return;
  }
  const fileName = target.relPath.split("/").at(-1) ?? target.relPath;
  await vscode.commands.executeCommand(
    "vscode.diff",
    buildHistoryUri(target.uri, fromPath, fromHash),
    buildHistoryUri(target.uri, toPath, toEntry.hash),
    vscode.l10n.t(
      "{0} ({1} ↔ {2})",
      fileName,
      new Date(fromNode.snapshot.at).toLocaleString(),
      new Date(toNode.snapshot.at).toLocaleString(),
    ),
    { preview: true, preserveFocus: true },
  );
}

/**
 * 폴더 시점 선택 → 내장 다중 파일 diff (spec UI — 폴더 대상 `vscode.changes`).
 * 시점 상태(경로별 마지막 항목 재생)와 현재 디스크가 다른 파일만 나열한다.
 */
export async function openFolderChanges(
  target: ResolvedTarget & { readonly uri: vscode.Uri },
  snapshot: Snapshot,
  signal?: AbortSignal,
): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(target.uri);
  if (folder === undefined) return;
  const state = await target.store.stateAt(target.relPath, snapshot.at);
  const index = await target.store.loadIndex();
  const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
  for (const [entryPath, hash] of state) {
    if (signal?.aborted === true) return;
    const fileUri = vscode.Uri.joinPath(folder.uri, entryPath);
    let current: vscode.FileStat | null = null; // null = 현재 파일 없음
    try {
      current = await vscode.workspace.fs.stat(fileUri);
    } catch {
      // 현재 없음 — 시점에 존재했다면 diff 대상
    }
    // 색인의 mtime/size 가 현재와 같으면 그 해시가 현재 내용 — 읽지 않는다 (스캔과 같은 판정).
    // 색인이 낡았으면 불일치로 떨어져 아래에서 읽으므로 변경을 놓치지 않는다
    const known = current === null ? undefined : index.get(entryPath);
    const knownHash =
      current !== null &&
      known !== undefined &&
      known.mtime === current.mtime &&
      known.size === current.size
        ? known.hash
        : undefined;
    const snapshotSize = hash === null ? 0 : await target.store.blobSize(hash);
    if ((current?.size ?? 0) > MAX_DIFF_SIZE || snapshotSize > MAX_DIFF_SIZE) {
      // 대용량 — 내용을 읽지 않는다. 색인으로 확정 못 하면 변경으로 본다 (놓치는 쪽보다 낫다)
      const currentHash = current === null ? null : knownHash;
      if (currentHash === hash) continue;
      // 목록에는 남기되 양쪽을 안내 텍스트 가상 문서로 — 변경 사실만 보이고 내용 로드는 없음
      resources.push([
        fileUri,
        buildHistoryUri(fileUri, entryPath, hash, "snapshot"),
        buildHistoryUri(fileUri, entryPath, hash, "current"),
      ]);
      continue;
    }
    let currentHash: string | null = null;
    if (current !== null) {
      if (knownHash !== undefined) {
        currentHash = knownHash;
      } else {
        try {
          currentHash = hashOf(await vscode.workspace.fs.readFile(fileUri));
        } catch {
          // stat 과 읽기 사이 삭제됨 — 없음 취급
        }
      }
    }
    if (currentHash === hash) continue;
    // 현재 파일이 없으면 실존 uri 대신 빈 가상 문서를 우측에 — 다중 diff 가 읽기 실패하지 않게
    const modifiedUri = currentHash === null ? buildHistoryUri(fileUri, entryPath, null) : fileUri;
    resources.push([fileUri, buildHistoryUri(fileUri, entryPath, hash), modifiedUri]);
  }
  if (signal?.aborted === true) return;
  const folderName = target.relPath === "" ? folder.name : (target.relPath.split("/").at(-1) ?? "");
  await vscode.commands.executeCommand(
    "vscode.changes",
    vscode.l10n.t("{0} ({1} ↔ Current)", folderName, new Date(snapshot.at).toLocaleString()),
    resources,
  );
}

/** 범위 내 rename 체인을 거슬러 `entryPath` 의 범위 시작 시점 경로를 찾는다. */
function originPathWithin(
  snapshots: readonly Snapshot[],
  entryPath: string,
  fromAt: number,
  toAt: number,
): string {
  let chainPath = entryPath;
  for (const snapshot of snapshots) {
    // listSnapshots = 최신순 — 범위 안을 최신부터 거슬러 올라간다
    if (snapshot.at > toAt || snapshot.at < fromAt) continue;
    const entry = snapshot.entries.find((snapshotEntry) => snapshotEntry.path === chainPath);
    if (entry?.renamedFrom !== undefined) chainPath = entry.renamedFrom;
  }
  return chainPath;
}

/**
 * 폴더 시점 범위선택 → 병합 다중 파일 diff (좌: 범위 시작 직전 상태, 우: 범위 끝 시점 상태).
 * 범위 내 rename 은 좌측을 옛 경로의 내용으로 이어 붙이고, 목록 라벨은 범위 끝 시점 경로를 쓴다.
 */
export async function openFolderRangeChanges(
  target: ResolvedTarget & { readonly uri: vscode.Uri },
  fromAt: number,
  toAt: number,
  signal?: AbortSignal,
): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(target.uri);
  if (folder === undefined) return;
  const before = await target.store.stateAt(target.relPath, fromAt - 1);
  const after = await target.store.stateAt(target.relPath, toAt);
  const snapshots = await target.store.listSnapshots();
  // rename 된 옛 경로는 새 경로 행에 흡수 — 삭제 행으로 중복 표시하지 않는다
  const origins = new Map<string, string>();
  for (const entryPath of after.keys()) {
    origins.set(entryPath, originPathWithin(snapshots, entryPath, fromAt, toAt));
  }
  const renamedAway = new Set(
    [...origins].filter(([entryPath, origin]) => origin !== entryPath).map(([, origin]) => origin),
  );
  const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
  for (const [entryPath, afterHash] of after) {
    if (signal?.aborted === true) return;
    if (renamedAway.has(entryPath)) continue;
    const beforeHash = before.get(origins.get(entryPath)!) ?? null;
    if (beforeHash === afterHash) continue;
    const fileUri = vscode.Uri.joinPath(folder.uri, entryPath);
    const beforeSize = beforeHash === null ? 0 : await target.store.blobSize(beforeHash);
    const afterSize = afterHash === null ? 0 : await target.store.blobSize(afterHash);
    if (beforeSize > MAX_DIFF_SIZE || afterSize > MAX_DIFF_SIZE) {
      // 대용량 — 내용을 읽지 않는다. 목록에는 남기되 양쪽을 안내 텍스트 가상 문서로
      resources.push([
        fileUri,
        buildHistoryUri(fileUri, origins.get(entryPath)!, beforeHash, "snapshot"),
        buildHistoryUri(fileUri, entryPath, afterHash, "current"),
      ]);
      continue;
    }
    resources.push([
      fileUri,
      buildHistoryUri(fileUri, origins.get(entryPath)!, beforeHash),
      buildHistoryUri(fileUri, entryPath, afterHash),
    ]);
  }
  if (signal?.aborted === true) return;
  const folderName = target.relPath === "" ? folder.name : (target.relPath.split("/").at(-1) ?? "");
  await vscode.commands.executeCommand(
    "vscode.changes",
    vscode.l10n.t(
      "{0} ({1} ↔ {2})",
      folderName,
      new Date(fromAt).toLocaleString(),
      new Date(toAt).toLocaleString(),
    ),
    resources,
  );
}

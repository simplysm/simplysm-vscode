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
 * 폴더 시점 선택 → 내장 다중 파일 diff (spec UI — 폴더 대상 `vscode.changes`).
 * 시점 상태(경로별 마지막 항목 재생)와 현재 디스크가 다른 파일만 나열한다.
 */
export async function openFolderChanges(
  target: ResolvedTarget & { readonly uri: vscode.Uri },
  snapshot: Snapshot,
): Promise<void> {
  const folder = vscode.workspace.getWorkspaceFolder(target.uri);
  if (folder === undefined) return;
  const state = await target.store.stateAt(target.relPath, snapshot.at);
  const index = await target.store.loadIndex();
  const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = [];
  for (const [entryPath, hash] of state) {
    const fileUri = vscode.Uri.joinPath(folder.uri, entryPath);
    let currentSize: number | null = null; // null = 현재 파일 없음
    try {
      currentSize = (await vscode.workspace.fs.stat(fileUri)).size;
    } catch {
      // 현재 없음 — 시점에 존재했다면 diff 대상
    }
    const snapshotSize = hash === null ? 0 : await target.store.blobSize(hash);
    if ((currentSize ?? 0) > MAX_DIFF_SIZE || snapshotSize > MAX_DIFF_SIZE) {
      // 대용량 — 내용을 읽지 않는다. 변경 판정은 색인의 마지막 기록 해시로 대체
      // (열람 직전 스캔 트리거가 색인을 최신으로 유지)
      const currentHash = currentSize === null ? null : (index.get(entryPath)?.hash ?? null);
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
    if (currentSize !== null) {
      try {
        currentHash = hashOf(await vscode.workspace.fs.readFile(fileUri));
      } catch {
        // stat 과 읽기 사이 삭제됨 — 없음 취급
      }
    }
    if (currentHash === hash) continue;
    // 현재 파일이 없으면 실존 uri 대신 빈 가상 문서를 우측에 — 다중 diff 가 읽기 실패하지 않게
    const modifiedUri = currentHash === null ? buildHistoryUri(fileUri, entryPath, null) : fileUri;
    resources.push([fileUri, buildHistoryUri(fileUri, entryPath, hash), modifiedUri]);
  }
  const folderName = target.relPath === "" ? folder.name : (target.relPath.split("/").at(-1) ?? "");
  await vscode.commands.executeCommand(
    "vscode.changes",
    vscode.l10n.t("{0} ({1} ↔ Current)", folderName, new Date(snapshot.at).toLocaleString()),
    resources,
  );
}

import * as vscode from "vscode";
import type { ResolvedTarget, Snapshot, SnapshotEntry } from "./storage.ts";

/**
 * 파일 단위 롤백 (spec 열람·복원 3~4) — 확인 다이얼로그 후 롤백 직전 자동 스냅샷을 남기고
 * 파일을 그 시점 내용으로 되돌린다. 반환 = 실제 수행 여부.
 */
export async function rollbackFile(
  target: ResolvedTarget & { readonly uri: vscode.Uri },
  snapshot: Snapshot,
  entryPath: string = target.relPath, // 그 시점의 파일 경로 (rename 체인, 기본 = 현재 경로)
): Promise<boolean> {
  const entry = snapshot.entries.find((snapshotEntry) => snapshotEntry.path === entryPath);
  if (entry === undefined) return false;
  const fileName = target.relPath.split("/").at(-1) ?? target.relPath;
  const rollbackButton = vscode.l10n.t("Rollback");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      'Rollback "{0}" to the state of {1}?',
      fileName,
      new Date(snapshot.at).toLocaleString(),
    ),
    {
      modal: true,
      detail: vscode.l10n.t(
        "The current state will be saved to Local History before rolling back.",
      ),
    },
    rollbackButton,
  );
  if (choice !== rollbackButton) return false;

  // 롤백 직전 자동 스냅샷 — 롤백 자체도 히스토리로 되돌릴 수 있게 (spec 열람·복원 4).
  // 현재 상태가 이미 최신 시점과 같으면(통상) 중복 시점을 만들지 않는다.
  let currentHash: string | null = null;
  try {
    currentHash = await target.store.saveBlob(await vscode.workspace.fs.readFile(target.uri));
  } catch {
    // 현재 파일 없음(삭제 상태에서의 롤백) — null(삭제) 로 기록
  }
  const snapshots = await target.store.listSnapshots(); // 최신순
  const latestHash = snapshots
    .flatMap((recorded) => recorded.entries)
    .find((recordedEntry) => recordedEntry.path === target.relPath)?.hash;
  if (currentHash !== latestHash) {
    await target.store.saveSnapshot([{ path: target.relPath, hash: currentHash }]);
  }

  if (entry.hash === null) {
    await vscode.workspace.fs.delete(target.uri); // 그 시점 = 삭제 상태
  } else {
    await vscode.workspace.fs.writeFile(target.uri, await target.store.readBlob(entry.hash));
  }
  return true;
}

/**
 * 폴더 단위 롤백 (spec 열람·복원 3~4) — 시점 상태(경로별 마지막 항목 재생)와 다른 파일만
 * 되돌린다. 삭제 파일 복원 포함, 기록 없는 파일은 건드리지 않는다. 반환 = 실제 수행 여부.
 */
export async function rollbackFolder(
  target: ResolvedTarget & { readonly uri: vscode.Uri },
  snapshot: Snapshot,
): Promise<boolean> {
  const folder = vscode.workspace.getWorkspaceFolder(target.uri);
  if (folder === undefined) return false;
  const folderName = target.relPath === "" ? folder.name : (target.relPath.split("/").at(-1) ?? "");
  const rollbackButton = vscode.l10n.t("Rollback");
  const choice = await vscode.window.showWarningMessage(
    vscode.l10n.t(
      'Rollback folder "{0}" to the state of {1}?',
      folderName,
      new Date(snapshot.at).toLocaleString(),
    ),
    {
      modal: true,
      detail: vscode.l10n.t(
        "Files with recorded history will be restored to that state, including deleted files. The current state will be saved to Local History before rolling back.",
      ),
    },
    rollbackButton,
  );
  if (choice !== rollbackButton) return false;

  // 시점 상태와 현재가 다른 파일만 수집
  const state = await target.store.stateAt(target.relPath, snapshot.at);
  const preEntries: SnapshotEntry[] = [];
  const operations: { uri: vscode.Uri; hash: string | null }[] = [];
  for (const [entryPath, hash] of state) {
    const fileUri = vscode.Uri.joinPath(folder.uri, entryPath);
    let currentHash: string | null = null;
    try {
      currentHash = await target.store.saveBlob(await vscode.workspace.fs.readFile(fileUri));
    } catch {
      // 현재 파일 없음 — null(삭제) 로 기록
    }
    if (currentHash === hash) continue;
    preEntries.push({ path: entryPath, hash: currentHash });
    operations.push({ uri: fileUri, hash });
  }
  if (operations.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t("The folder is already in that state."));
    return false;
  }

  // 롤백 직전 자동 스냅샷 — 롤백 자체도 히스토리로 되돌릴 수 있게 (spec 열람·복원 4)
  await target.store.saveSnapshot(preEntries);

  for (const operation of operations) {
    if (operation.hash === null) {
      await vscode.workspace.fs.delete(operation.uri);
    } else {
      // 삭제됐던 하위 폴더 복원 대비 — 부모 디렉터리를 먼저 보장 (idempotent)
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(operation.uri, ".."));
      await vscode.workspace.fs.writeFile(
        operation.uri,
        await target.store.readBlob(operation.hash),
      );
    }
  }
  return true;
}

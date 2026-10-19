import * as vscode from "vscode";
import { formatDateTime, formatRange } from "./time-format.ts";
import type { ChangeRange } from "./history-changes.ts";
import type { Comparison, FileSide } from "./history-selection.ts";
import type { WorkspaceStores } from "./storage.ts";

/** 과거 내용을 공급하는 읽기 전용 파일 시스템 스킴 (spec 「3. 열람」 과거 내용 공급). */
export const historyScheme = "simplysm-local-history";

/**
 * 과거 내용 uri — path 는 그 시점의 원래 파일 경로(언어·이미지 판정이 현재 파일과 같게), query 는 blob 해시.
 * `hash === null` = 그 시점에 파일이 없음 → 빈 내용.
 */
function buildHistoryUri(
  folderUri: vscode.Uri,
  entryPath: string,
  hash: string | null,
): vscode.Uri {
  return vscode.Uri.joinPath(folderUri, entryPath).with({
    scheme: historyScheme,
    query: new URLSearchParams({ hash: hash ?? "" }).toString(),
  });
}

/**
 * 과거 내용을 원래 바이트 그대로 공급하는 읽기 전용 provider — VS Code 가 과거 쪽도 현재 파일처럼
 * 다룬다(이진 안내·인코딩 설정·이미지 미리보기·대용량 처리). blob 은 해시로 고정된 내용이라 바뀌지 않는다.
 */
class HistoryFileSystemProvider implements vscode.FileSystemProvider {
  private readonly stores: WorkspaceStores;
  /** blob 해시 → 원본 크기 — stat 마다 압축을 풀지 않게. 내용이 해시로 고정이라 무효화가 없다. */
  private readonly sizes = new Map<string, number>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changeEmitter.event;

  constructor(stores: WorkspaceStores) {
    this.stores = stores;
  }

  watch(): vscode.Disposable {
    // 내용이 바뀌지 않으므로 알릴 변경이 없다
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const hash = hashParamOf(uri);
    let size = hash === "" ? 0 : this.sizes.get(hash);
    if (size === undefined) size = (await this.readFile(uri)).byteLength;
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: 0,
      size,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const hash = hashParamOf(uri);
    if (hash === "") return new Uint8Array(); // 그 시점에 없던 파일
    const fileUri = uri.with({ scheme: "file", query: "" });
    const resolved = await this.stores.resolve(fileUri);
    if (resolved === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    let content: Uint8Array;
    try {
      content = await resolved.store.readBlob(hash);
    } catch {
      // blob 없음(정리됨 등) — VS Code 가 찾을 수 없는 파일로 표시한다
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.sizes.set(hash, content.byteLength);
    return content;
  }

  readDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.FileNotADirectory(uri);
  }

  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(oldUri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }
}

/** 과거 내용 uri 의 blob 해시 — "" = 그 시점에 없던 파일. */
function hashParamOf(uri: vscode.Uri): string {
  return new URLSearchParams(uri.query).get("hash") ?? "";
}

export function registerHistoryFileSystemProvider(stores: WorkspaceStores): vscode.Disposable {
  return vscode.workspace.registerFileSystemProvider(
    historyScheme,
    new HistoryFileSystemProvider(stores),
    // path 가 워크스페이스 파일 경로라 대소문자 구분은 VS Code 디스크 provider 와 같게 Linux 에서만 한다.
    // Windows 에서 구분한다고 선언하면 이미지 미리보기 webview 가 자기 파일을 허용 루트 밖으로 보고 거부한다(401).
    { isReadonly: true, isCaseSensitive: process.platform === "linux" },
  );
}

/**
 * diff 제목 (spec 「3. 열람」 고르기와 diff) — 이름 뒤에 어느 변경인지만 적는다. 왼쪽은 항상 직전,
 * 오른쪽은 항상 직후라 밝힐 필요가 없다. 범위의 끝 시각은 시작과 같은 날이면 시각만 적는다.
 */
function diffTitle(name: string, range: ChangeRange): string {
  if (range.fromAt === range.toAt) {
    return vscode.l10n.t("{0} (change at {1})", name, formatDateTime(range.toAt));
  }
  const [from, to] = formatRange(range.fromAt, range.toAt);
  return vscode.l10n.t("{0} (changes {1} – {2})", name, from, to);
}

/**
 * 비교를 내장 에디터로 연다 (spec 「3. 열람」 고르기와 diff) — 좌 = 직전(beforePath, beforeHash),
 * 우 = 직후(afterPath, afterHash). 해시 null 인 쪽은 그때 없던 파일이라 빈 내용이다.
 * 파일 하나는 `vscode.diff`(목록의 키보드 포커스를 빼앗지 않게 preserveFocus), 여러 파일은 `vscode.changes` 다.
 * 바뀐 파일이 없어도 연다 — 파일은 양쪽이 같은 diff, 폴더는 빈 다중 diff("No Changed Files"). 둘 다 미리보기라
 * 앞의 diff 미리보기 탭을 대체한다. 근거(spec): 아무것도 열지 않으면 앞의 diff 가 남아 고른 것의 diff 로 오해한다.
 * `vscode.changes` 는 preserveFocus 를 받지 않아 포커스를 에디터로 가져간다. 목록으로 되돌리지 않는다 —
 * 공개 API 로 되돌리면 고른 줄이 목록 가운데로 스크롤돼 다음 클릭이 다른 줄을 고른다(spec 「3. 열람」).
 */
export async function openComparison(folderUri: vscode.Uri, comparison: Comparison): Promise<void> {
  const title = diffTitle(comparison.name, comparison.range);
  const uriOf = (side: FileSide) => buildHistoryUri(folderUri, side.path, side.hash);
  if (comparison.view === "diff") {
    await vscode.commands.executeCommand(
      "vscode.diff",
      uriOf(comparison.before),
      uriOf(comparison.after),
      title,
      { preview: true, preserveFocus: true },
    );
    return;
  }
  await vscode.commands.executeCommand(
    "vscode.changes",
    title,
    // [항목의 작업 파일 uri(`vscode.changes` 의 label 자리), 직전, 직후]
    comparison.changes.map((change) => [
      vscode.Uri.joinPath(folderUri, change.path),
      uriOf({ path: change.beforePath, hash: change.beforeHash }),
      uriOf({ path: change.afterPath, hash: change.afterHash }),
    ]),
  );
}

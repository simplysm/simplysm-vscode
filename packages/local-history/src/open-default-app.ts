import * as vscode from "vscode";
import { fileNameSafe, splitExtension } from "./default-app-copy.ts";
import { openInOs } from "./os-open.ts";
import { baseName } from "./rel-path.ts";
import { formatDateTime } from "./time-format.ts";
import type { CopyFolder, CopyNameParts } from "./default-app-copy.ts";
import type { ChangeSides } from "./history-selection.ts";
import type { HistoryStore } from "./storage.ts";

// 기본 앱으로 열기 (spec 「3. 열람」) — 변경의 직전 · 직후 내용을 읽기 전용 사본으로 만들어 OS 기본 앱으로 연다.
// 작업 파일과 이력은 건드리지 않는다 — 내용은 저장소의 blob 을 읽기만 하고, 사본은 워크스페이스 밖(OS 임시 폴더)에 쓴다.

/** 열 쪽 — 변경 직전 또는 직후. */
export type ChangeSide = "before" | "after";

/**
 * 사본 이름의 재료 — 원래 이름(줄기 · 확장자)과, 줄기에 시각 · 직전 · 직후 표시를 붙이는 문구.
 * 시각은 다른 화면과 같은 표기다. 이름이 길면 사본 폴더가 줄기만 자른다(spec 「3. 열람」).
 */
function copyNameParts(fileName: string, at: number, side: ChangeSide): CopyNameParts {
  const [stem, ext] = splitExtension(fileName);
  const time = fileNameSafe(formatDateTime(at));
  return {
    stem,
    ext,
    decorate: (shown) =>
      side === "before"
        ? vscode.l10n.t("{0} (before change at {1})", shown, time)
        : vscode.l10n.t("{0} (after change at {1})", shown, time),
  };
}

/**
 * 변경의 한쪽을 기본 앱으로 연다. 사본의 이름 · 확장자는 그쪽 경로의 것이다(이름 변경이면 직전 = 옛 이름).
 * 실패(내용 읽기 · 사본 쓰기 · 열기 명령)는 던진다 — 부른 쪽이 알린다.
 * 원격 작업에서는 아무것도 하지 않는다 — 확장이 원격 컴퓨터에서 실행되어 사용자 PC 에 열리지 않는다(spec).
 * 메뉴는 `!remoteName` 으로 숨기고, 여기는 명령이 다른 경로로 불린 경우다.
 */
export async function openInDefaultApp(
  copies: CopyFolder,
  store: HistoryStore,
  sides: ChangeSides,
  side: ChangeSide,
): Promise<void> {
  if (vscode.env.remoteName !== undefined) return;
  const file = sides[side];
  if (file.hash === null) return; // 그쪽에 내용이 없다 — 메뉴에도 없다
  const content = await store.readBlob(file.hash);
  const copyPath = await copies.write(copyNameParts(baseName(file.path), sides.at, side), content);
  await openInOs(copyPath);
}

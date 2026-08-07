// tasks 리스트 재배치 순수 로직 (spec §4.4·§4.7) — 줄 배열 입출력만, vscode·DOM 무의존.
// webview main.ts 가 이 함수들로 다음 배열을 계산한 뒤 DOM 반영·저장을 수행한다.
// 배열을 인자로 받으므로, 삽입·이동 대상을 미리 제거한 배열(nextLines)에도 같은 계산을 재사용한다.

import {
  isGroupHeader,
  isCollapsed,
  type TaskItem,
  type GroupHeader,
  type TaskLine,
} from "./tasks-model.ts";

/** 그룹 블록(헤더 + 연속 소속 항목)의 [시작, 끝) 줄 범위. */
export function groupBlockRange(lines: readonly TaskLine[], header: GroupHeader): [number, number] {
  const start = lines.indexOf(header);
  let end = start + 1;
  while (end < lines.length && !isGroupHeader(lines[end]!)) end++;
  return [start, end];
}

/** 그룹(또는 미분류 = null) 소속 블록의 끝 = 그 섹션 삽입 위치. */
export function sectionEndIndex(lines: readonly TaskLine[], header: GroupHeader | null): number {
  if (header == null) {
    const firstHeader = lines.findIndex((line) => isGroupHeader(line));
    return firstHeader === -1 ? lines.length : firstHeader;
  }
  return groupBlockRange(lines, header)[1];
}

/** collapsed 필드를 떼어낸 펼친 헤더 (미지 필드 보존, spec §5.2). */
export function expandHeader(header: GroupHeader): GroupHeader {
  const { collapsed: _collapsed, ...rest } = header;
  return rest as GroupHeader;
}

/** 표시 구조 — 헤더 아래 연속 항목이 소속 (spec §5.2). 첫 섹션은 미분류(header=null). */
export interface LayoutSection {
  readonly header: GroupHeader | null;
  readonly items: TaskItem[];
}

/** 파일 줄 순서 → 표시 구조. */
export function computeLayout(lines: readonly TaskLine[]): LayoutSection[] {
  const layout: LayoutSection[] = [{ header: null, items: [] }];
  for (const line of lines) {
    if (isGroupHeader(line)) layout.push({ header: line, items: [] });
    else layout[layout.length - 1]!.items.push(line);
  }
  return layout;
}

/** moveLine 결과 — 이동한 배열 + (접힌 그룹 진입 시) 펼쳐진 헤더 재바인딩 정보. */
export interface MoveLineResult {
  readonly lines: TaskLine[];
  /** 접힘→펼침 전환된 헤더 (없으면 null) — 호출측 DOM 재바인딩용. */
  readonly expanded: { readonly from: GroupHeader; readonly to: GroupHeader } | null;
}

/**
 * 항목을 한 칸(delta) 이동한 배열. 그룹 헤더 줄을 넘으면 소속 변경, 목록 끝이면 null(무동작).
 * 이동 후 소속 그룹이 접혀 있으면 펼쳐, 이동 항목이 시야에서 사라지지 않게 함 (spec §4.4).
 */
export function moveLine(
  lines: readonly TaskLine[],
  item: TaskItem,
  delta: -1 | 1,
): MoveLineResult | null {
  const index = lines.indexOf(item);
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= lines.length) return null;
  let nextLines = lines.filter((cur) => cur !== item);
  nextLines.splice(nextIndex, 0, item);
  // 이동 후 소속 그룹(직전 헤더) 역탐색
  let owner: GroupHeader | null = null;
  for (let i = nextLines.indexOf(item) - 1; i >= 0; i--) {
    const line = nextLines[i]!;
    if (isGroupHeader(line)) {
      owner = line;
      break;
    }
  }
  if (owner != null && isCollapsed(owner)) {
    const expanded = expandHeader(owner);
    nextLines = nextLines.map((cur) => (cur === owner ? expanded : cur));
    return { lines: nextLines, expanded: { from: owner, to: expanded } };
  }
  return { lines: nextLines, expanded: null };
}

/**
 * 그룹 블록(헤더 + 소속 항목)을 통째로 target 그룹 앞/뒤로 옮긴 배열 (spec §4.7).
 * target=null 이면 첫 그룹 앞(= 미분류 바로 뒤)으로.
 */
export function moveGroupBlock(
  lines: readonly TaskLine[],
  header: GroupHeader,
  target: GroupHeader | null,
  before: boolean,
): TaskLine[] {
  const [start, end] = groupBlockRange(lines, header);
  const block = lines.slice(start, end);
  const rest = [...lines.slice(0, start), ...lines.slice(end)];
  let insertAt: number;
  if (target == null) {
    const firstHeader = rest.findIndex((line) => isGroupHeader(line));
    insertAt = firstHeader === -1 ? rest.length : firstHeader;
  } else if (before) {
    insertAt = rest.indexOf(target);
  } else {
    insertAt = sectionEndIndex(rest, target);
  }
  rest.splice(insertAt, 0, ...block);
  return rest;
}

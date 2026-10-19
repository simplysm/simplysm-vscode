import { isUnderPrefix } from "./rel-path.ts";
import type { Snapshot, SnapshotEntry } from "./storage.ts";

// 변경의 직전 ↔ 직후 계산 (spec 「3. 열람」·「4. 복원」) — 목록의 변경 종류, 비교의 양쪽, 복원 결과가
// 모두 이 계산을 쓴다. diff 의 왼쪽과 복원 결과가 같아야 하기 때문이다.
// 입력 스냅샷 목록은 `HistoryStore.listSnapshots()` 와 같은 최신순(at 엄격 내림차순)이다.

/** 이력 대상 — `path` 는 워크스페이스 폴더 기준 상대 경로. 파일은 지금 경로, 폴더는 "" = 폴더 전체. */
export interface HistoryScope {
  readonly kind: "file" | "folder";
  readonly path: string;
}

/** 변경 범위 — 시작 at ~ 끝 at(양끝 포함). 줄 하나는 `fromAt === toAt` 인 길이 1 범위다. */
export interface ChangeRange {
  readonly fromAt: number;
  readonly toAt: number;
}

export type ChangeKind = "added" | "deleted" | "modified" | "renamed";

/** 범위 안에서 바뀜 파일 하나의 직전 ↔ 직후. 해시 null = 그때 파일이 없음(기록 없음 포함). */
export interface FileChange {
  /**
   * 항목 경로. 파일 이력은 그 파일의 지금 경로(복원이 내용을 쓸 곳)다.
   * 폴더 이력은 폴더 안에서 항목이 서는 경로다 — 보통 `afterPath`, 폴더 밖으로 나간 이동이면 `beforePath`.
   */
  readonly path: string;
  /** 범위 시작 직전에 그 내용이 있던 경로 — 이름 변경이면 옛 경로, 아니면 `afterPath` 와 같다. */
  readonly beforePath: string;
  /** 범위 끝 직후의 경로 — 이름 변경이면 새 경로. 파일 이력은 범위 뒤의 이름 변경 전 경로다. */
  readonly afterPath: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly kind: ChangeKind;
  /**
   * 폴더 이력에서 폴더 밖에 있는 쪽 — 폴더 경계를 넘은 이동일 때만 값이 있다.
   * "after" = 폴더 밖으로 나간 파일(항목은 옛 경로 자리), "before" = 밖에서 들어온 파일. 파일 이력은 항상 null.
   * 복원이 폴더 밖 경로를 바꾸는 이동을 셀 때 쓴다.
   */
  readonly outside: "before" | "after" | null;
}

/** 이력 목록의 줄 — 스냅샷 하나. `pathAt` = 그 줄에서 대상 파일의 경로(파일 이력만, rename 체인). */
export interface HistoryRow {
  readonly snapshot: Snapshot;
  readonly pathAt?: string;
}

/**
 * 대상의 줄 목록(최신순). 파일 이력은 rename 체인(`renamedFrom`)을 따라 옛 경로의 줄까지 잇는다.
 * 폴더 이력은 폴더 아래 경로가 든 스냅샷이 줄이다.
 */
export function listRows(snapshots: readonly Snapshot[], scope: HistoryScope): HistoryRow[] {
  if (scope.kind === "folder") {
    return snapshots
      .filter((snapshot) => snapshot.entries.some((entry) => isUnderPrefix(entry.path, scope.path)))
      .map((snapshot) => ({ snapshot }));
  }
  const rows: HistoryRow[] = [];
  let chainPath = scope.path;
  for (const snapshot of snapshots) {
    const entry = entryAt(snapshot, chainPath);
    if (entry === undefined) continue;
    rows.push({ snapshot, pathAt: chainPath });
    if (entry.renamedFrom !== undefined) chainPath = entry.renamedFrom;
  }
  return rows;
}

/**
 * 범위마다 바뀜 파일의 직전 ↔ 직후를 구한다. 반환의 i 번째 = `ranges[i]` 의 결과(순서는 정하지 않는다).
 * 직전 = 범위 시작보다 이른 마지막 항목, 직후 = 범위 끝 이하의 마지막 항목이다. 내용이 같고 경로도 같으면 빠진다.
 * - 파일 이력: 항목은 대상 파일 하나다. rename 체인을 따라 직전·직후의 경로를 찾는다.
 * - 폴더 이력: 범위 안의 이름 변경을 새 경로 항목에 흡수한다. 그 항목의 직전은 옛 경로의 내용이고,
 *   옛 경로는 삭제 항목으로 따로 서지 않는다. 이동은 폴더 경계와 상관없이 항목 하나다 —
 *   밖에서 들어오면 새 경로 자리에, 밖으로 나가면 옛 경로 자리에 선다(`outside`).
 *
 * 비용: 범위 안 스냅샷 + 직전 상태를 찾는 거슬러 읽기 한 번(모든 범위가 함께 쓴다).
 */
export function computeChanges(
  snapshots: readonly Snapshot[],
  scope: HistoryScope,
  ranges: readonly ChangeRange[],
): FileChange[][] {
  const drafts =
    scope.kind === "folder"
      ? ranges.map((range) => traceFolderRange(snapshots, scope.path, range))
      : traceFileRanges(snapshots, scope.path, ranges);
  resolveStates(
    snapshots,
    drafts.flatMap((rangeDrafts) => rangeDrafts.flatMap((draft) => draft.before ?? [])),
  );
  return drafts.map((rangeDrafts) =>
    rangeDrafts.flatMap((draft) => {
      const change = toChange(scope, draft);
      return change === undefined ? [] : [change];
    }),
  );
}

/** 직전 상태 조회 — `beforeAt` 보다 이른 마지막 항목의 해시. `resolveStates` 가 `hash` 를 채운다. */
interface StateRequest {
  readonly path: string;
  readonly beforeAt: number;
  /**
   * 첫 항목이 삭제면 한 번 건너뛴다 — 이름 변경의 옛 경로 삭제가 새 경로보다 이른 스냅샷에 따로 적힌 경우.
   * (기록기가 옛 경로 삭제를 먼저 큐에 넣고 새 경로를 읽는 사이 debounce 가 끝나면 둘이 갈린다.)
   */
  skipDeletion: boolean;
  hash: string | null;
}

/** 항목 초안 — 직전 해시는 `before` 조회로 채운다(`before` 없음 = 직전에 없었음이 확정). */
interface Draft {
  readonly path: string;
  readonly beforePath: string;
  readonly afterPath: string;
  readonly afterHash: string | null;
  readonly before: StateRequest | undefined;
  readonly outside: "before" | "after" | null;
}

function toChange(scope: HistoryScope, draft: Draft): FileChange | undefined {
  const beforeHash = draft.before?.hash ?? null;
  const { afterHash } = draft;
  let kind: ChangeKind;
  if (draft.beforePath !== draft.afterPath) kind = "renamed";
  else if (beforeHash === afterHash)
    return undefined; // 없던 것이 없거나, 내용이 같다
  else if (beforeHash === null) kind = "added";
  else if (afterHash === null) kind = "deleted";
  else kind = "modified";
  return {
    path: draft.path,
    beforePath: draft.beforePath,
    afterPath: draft.afterPath,
    beforeHash,
    afterHash,
    kind,
    outside: draft.outside,
  };
}

function entryAt(snapshot: Snapshot, entryPath: string): SnapshotEntry | undefined {
  return snapshot.entries.find((entry) => entry.path === entryPath);
}

function hasDeletionAt(snapshot: Snapshot, entryPath: string): boolean {
  return snapshot.entries.some((entry) => entry.path === entryPath && entry.hash === null);
}

/** 최신순 목록에서 `at` 이하인 첫 스냅샷의 위치(없으면 길이). */
function firstIndexAtOrBefore(snapshots: readonly Snapshot[], at: number): number {
  let low = 0;
  let high = snapshots.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (snapshots[middle].at <= at) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** 범위 → 최신순 목록의 위치 구간 [start, end). */
function indexSpan(snapshots: readonly Snapshot[], range: ChangeRange): [number, number] {
  return [
    firstIndexAtOrBefore(snapshots, range.toAt),
    firstIndexAtOrBefore(snapshots, range.fromAt - 1),
  ];
}

function stateRequest(path: string, beforeAt: number, skipDeletion: boolean): StateRequest {
  return { path, beforeAt, skipDeletion, hash: null };
}

/**
 * 파일 이력 — 범위마다 항목 0~1개. 지금 경로에서 rename 체인을 거슬러 범위 끝의 경로를, 범위 안의
 * 이름 변경을 더 거슬러 범위 시작 직전의 경로를 찾는다(`listRows` 와 같은 체인).
 * 범위를 끝 위치 순으로 처리해 체인 거슬러 가기를 모든 범위가 나눠 쓴다.
 */
function traceFileRanges(
  snapshots: readonly Snapshot[],
  filePath: string,
  ranges: readonly ChangeRange[],
): Draft[][] {
  const result: Draft[][] = ranges.map(() => []);
  const order = ranges
    .map((range, rangeIndex) => ({ range, rangeIndex, span: indexSpan(snapshots, range) }))
    .sort((a, b) => a.span[0] - b.span[0]);
  let cursor = 0; // 체인 경로를 반영한 위치 — cursor 보다 새로운 스냅샷의 이름 변경을 거슬렀다
  let chainPath = filePath;
  for (const { range, rangeIndex, span } of order) {
    const [start, end] = span;
    for (; cursor < start; cursor++) {
      const renamedFrom = entryAt(snapshots[cursor], chainPath)?.renamedFrom;
      if (renamedFrom !== undefined) chainPath = renamedFrom;
    }
    const afterPath = chainPath;
    let afterHash: string | null | undefined; // undefined = 범위 안에 항목 없음 → 변경 없음
    let beforePath = afterPath;
    let ownDeletionSeen = true; // 마지막 이름 변경의 옛 경로 삭제를 범위 안에서 보았는가
    for (let index = start; index < end; index++) {
      const entry = entryAt(snapshots[index], beforePath);
      if (entry === undefined) continue;
      if (afterHash === undefined) afterHash = entry.hash;
      if (entry.renamedFrom !== undefined) {
        beforePath = entry.renamedFrom;
        ownDeletionSeen = hasDeletionAt(snapshots[index], beforePath);
      } else {
        // 옛 경로의 더 이른 항목 — 삭제면 그것이 이름 변경의 삭제, 아니면 삭제는 이미 갈린 뒤가 아니다
        ownDeletionSeen = true;
      }
    }
    if (afterHash === undefined) continue;
    result[rangeIndex].push({
      path: filePath,
      beforePath,
      afterPath,
      afterHash,
      before: stateRequest(beforePath, range.fromAt, !ownDeletionSeen),
      outside: null,
    });
  }
  return result;
}

/** 폴더 항목 추적 중간 결과 — `origin` = 범위 시작 직전의 경로, `born` = 범위 안에서 생겨 직전이 없음. */
interface FolderTrace {
  readonly path: string;
  readonly afterHash: string | null;
  origin: string;
  renamed: boolean;
  born: boolean;
  /** 이름 변경의 옛 경로 삭제를 범위 안에서 못 봤다 — 직전 조회가 그 삭제를 건너뛴다. */
  skipDeletion: boolean;
}

/**
 * 폴더 이력 — 범위 안에서 폴더 아래 경로마다, 마지막 항목에서 거슬러 올라가며 직전 경로를 찾는다.
 * - 이름 변경(`renamedFrom`)을 만나면 옛 경로로 옮겨 간다.
 * - 더 이른 삭제를 만나면 멈춘다. 이름 변경을 거쳤다면 지금의 내용은 그 삭제 뒤에 생긴 것이다(`born`).
 *   이름 변경 자신의 옛 경로 삭제는 멈춤으로 보지 않는다.
 * 그다음 이름 변경이 가져간 옛 경로를 정리한다. 그 경로의 삭제는 흡수되고, 그 경로에 새로 생긴 파일은 생성이다.
 */
function traceFolderRange(
  snapshots: readonly Snapshot[],
  prefix: string,
  range: ChangeRange,
): Draft[] {
  const [start, end] = indexSpan(snapshots, range);
  const traces: FolderTrace[] = [];
  const seen = new Set<string>();
  for (let index = start; index < end; index++) {
    for (const entry of snapshots[index].entries) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      const trace = traceOrigin(snapshots, index, end, entry);
      // 폴더 밖 경로는 폴더 안에서 나간 이동만 항목이 된다
      const movedOut = trace.renamed && !trace.born && isUnderPrefix(trace.origin, prefix);
      if (isUnderPrefix(entry.path, prefix) || movedOut) traces.push(trace);
    }
  }
  const claimed = new Set(
    traces.filter((trace) => trace.renamed && !trace.born).map((trace) => trace.origin),
  );
  const drafts: Draft[] = [];
  for (const trace of traces) {
    if (!trace.renamed && claimed.has(trace.path)) {
      if (trace.afterHash === null) continue; // 이름 변경의 옛 경로 — 새 경로 항목에 흡수
      trace.born = true; // 옛 내용은 이름 변경으로 떠났다 — 이 경로의 지금 파일은 새로 생긴 것
    }
    const renamed = trace.renamed && !trace.born;
    const movedOut = !isUnderPrefix(trace.path, prefix);
    const movedIn = renamed && !isUnderPrefix(trace.origin, prefix);
    drafts.push({
      path: movedOut ? trace.origin : trace.path, // 항목은 폴더 안의 경로 자리에 선다
      beforePath: renamed ? trace.origin : trace.path,
      afterPath: trace.path,
      afterHash: trace.afterHash,
      before: trace.born
        ? undefined
        : stateRequest(trace.origin, range.fromAt, renamed && trace.skipDeletion),
      outside: movedOut ? "after" : movedIn ? "before" : null,
    });
  }
  return drafts;
}

function traceOrigin(
  snapshots: readonly Snapshot[],
  latestIndex: number,
  end: number,
  latest: SnapshotEntry,
): FolderTrace {
  const trace: FolderTrace = {
    path: latest.path,
    afterHash: latest.hash,
    origin: latest.path,
    renamed: false,
    born: false,
    skipDeletion: false,
  };
  if (latest.hash === null) return trace; // 삭제로 끝난 항목 — 그 경로의 직전과 비교한다
  let current = latest;
  let index = latestIndex;
  for (;;) {
    if (current.renamedFrom !== undefined) {
      trace.origin = current.renamedFrom;
      trace.renamed = true;
      trace.skipDeletion = !hasDeletionAt(snapshots[index], trace.origin);
    }
    let found: SnapshotEntry | undefined;
    for (index++; index < end; index++) {
      found = entryAt(snapshots[index], trace.origin);
      if (found === undefined) continue;
      if (found.hash === null && trace.skipDeletion) {
        trace.skipDeletion = false; // 이름 변경 자신의 옛 경로 삭제
        found = undefined;
        continue;
      }
      break;
    }
    if (found === undefined) return trace;
    if (found.hash === null) {
      // 이름 변경을 거친 체인이면 그 내용은 이 삭제 뒤에 생겼다. 같은 경로라면 그 경로의 직전과 비교한다(상태 비교)
      trace.born = trace.renamed;
      return trace;
    }
    trace.skipDeletion = false; // 옛 경로에 더 이른 내용이 있다 — 이름 변경의 삭제가 이보다 이를 수 없다
    current = found;
  }
}

/**
 * 직전 상태 일괄 조회 — 최신에서 오래된 쪽으로 한 번 읽으며 요청마다 `beforeAt` 보다 이른 첫 항목을 찾는다.
 * 모든 요청이 풀리면 멈춘다. 끝까지 못 찾은 요청 = 기록 없음(null).
 */
function resolveStates(snapshots: readonly Snapshot[], requests: readonly StateRequest[]): void {
  const order = requests.toSorted((a, b) => b.beforeAt - a.beforeAt);
  const pending = new Map<string, StateRequest[]>();
  let next = 0;
  let index = 0;
  while (next < order.length || pending.size > 0) {
    if (pending.size === 0) {
      // 기다리는 요청이 없으면 다음 요청이 보기 시작하는 위치로 건너뛴다
      index = Math.max(index, firstIndexAtOrBefore(snapshots, order[next].beforeAt - 1));
    }
    if (index >= snapshots.length) break;
    const snapshot = snapshots[index++];
    for (; next < order.length && order[next].beforeAt > snapshot.at; next++) {
      const request = order[next];
      const waiting = pending.get(request.path);
      if (waiting === undefined) pending.set(request.path, [request]);
      else waiting.push(request);
    }
    for (const entry of snapshot.entries) {
      const waiting = pending.get(entry.path);
      if (waiting === undefined) continue;
      const unresolved = waiting.filter((request) => {
        if (entry.hash === null && request.skipDeletion) {
          request.skipDeletion = false;
          return true;
        }
        request.hash = entry.hash;
        return false;
      });
      if (unresolved.length === 0) pending.delete(entry.path);
      else pending.set(entry.path, unresolved);
    }
  }
}

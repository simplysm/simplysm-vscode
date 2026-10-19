// 워크스페이스 폴더 기준 상대 경로(구분자 `/`, 폴더 자신은 "")의 규칙 — vscode 에 의존하지 않아 단위 테스트에서도 쓴다.

/** 경로가 prefix(폴더 상대 경로, "" = 전체) 하위인지 판정. */
export function isUnderPrefix(entryPath: string, prefix: string): boolean {
  return prefix === "" || entryPath === prefix || entryPath.startsWith(`${prefix}/`);
}

/** 상위 폴더 경로 — 폴더 바로 아래면 "". */
export function parentPath(entryPath: string): string {
  const slash = entryPath.lastIndexOf("/");
  return slash < 0 ? "" : entryPath.slice(0, slash);
}

/** 경로의 마지막 이름. */
export function baseName(entryPath: string): string {
  return entryPath.slice(entryPath.lastIndexOf("/") + 1);
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** 이름 순서 — 탐색기처럼 숫자는 값으로, 대소문자는 동점일 때만 가른다. */
function compareNames(a: string, b: string): number {
  return nameCollator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** 탐색기 순서(폴더 먼저, 이름순)의 깊이 우선 나열 순서 — 같은 단계에서 폴더 아래 파일이 먼저다. */
export function compareTreeOrder(a: string, b: string): number {
  const aSegments = a.split("/");
  const bSegments = b.split("/");
  for (let index = 0; ; index++) {
    const aIsFolder = index < aSegments.length - 1;
    const bIsFolder = index < bSegments.length - 1;
    if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
    const order = compareNames(aSegments[index], bSegments[index]);
    if (order !== 0 || !aIsFolder) return order;
  }
}

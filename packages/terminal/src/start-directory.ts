// 새 세션이 시작할 폴더의 후보를 정한다. 내장 터미널과 같은 규칙이라, 후보가 한 곳으로 모이면
// 폴더가 여럿이어도 묻지 않는다.

import path from "node:path";

export interface WorkspaceFolderCwd {
  readonly name: string;
  /** 워크스페이스 폴더의 절대 경로. */
  readonly path: string;
  /** 그 폴더에 적용된 `terminal.integrated.cwd`. 지정하지 않았으면 없음. */
  readonly configuredCwd?: string;
}

export interface StartDirectoryCandidate {
  /** 어느 폴더에서 온 후보인지 드러내, 재정의된 폴더가 어디로 가는지 보이게 한다. */
  readonly folderName: string;
  readonly path: string;
}

/** 폴더마다 후보를 하나씩 만들고 같은 경로를 지우면서 순서를 지킨다. */
export function resolveStartDirectoryCandidates(
  folders: readonly WorkspaceFolderCwd[],
): StartDirectoryCandidate[] {
  const candidates: StartDirectoryCandidate[] = [];
  const seenPaths = new Set<string>();

  for (const folder of folders) {
    const configured = folder.configuredCwd;
    const startPath =
      configured == null || configured.length === 0
        ? path.resolve(folder.path)
        : path.resolve(folder.path, configured);
    if (seenPaths.has(startPath)) continue;
    seenPaths.add(startPath);
    candidates.push({ folderName: folder.name, path: startPath });
  }

  return candidates;
}

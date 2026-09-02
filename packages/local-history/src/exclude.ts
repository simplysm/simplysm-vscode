import * as vscode from "vscode";
import { Minimatch } from "minimatch";

// 제외 판정에 참여하는 설정 3개 — 변경 시 폴더별 matcher 재구축
const CONFIG_KEYS = ["files.exclude", "files.watcherExclude", "simplysm-local-history.exclude"];

/**
 * 기록 제외 판정 — `files.exclude` + `files.watcherExclude` + 자체 `exclude` 설정의 glob 합성.
 * Recorder(이벤트)·Scanner(순회)·prune(소급 정리)이 같은 판정을 공유한다.
 */
export class Excludes implements vscode.Disposable {
  private readonly matchers = new Map<string, FolderMatcher>();
  private readonly disposable: vscode.Disposable;

  constructor() {
    this.disposable = vscode.workspace.onDidChangeConfiguration((event) => {
      if (CONFIG_KEYS.some((key) => event.affectsConfiguration(key))) this.matchers.clear();
    });
  }

  /** uri 가 속한 폴더 기준 relPath(구분자 `/`)가 제외 대상인지 — 상위 폴더가 걸려도 제외. */
  isExcluded(uri: vscode.Uri, relPath: string): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder === undefined) return false;
    const folderKey = folder.uri.toString();
    let matcher = this.matchers.get(folderKey);
    if (matcher === undefined) {
      matcher = new FolderMatcher(folder);
      this.matchers.set(folderKey, matcher);
    }
    return matcher.isExcluded(relPath);
  }

  dispose(): void {
    this.disposable.dispose();
  }
}

/** 워크스페이스 폴더 1개의 제외 matcher — 설정을 읽어 glob 을 미리 컴파일. */
class FolderMatcher {
  private readonly patterns: Minimatch[];
  /** 프리픽스별 판정 memo — prune·스캔의 대량 반복 판정 가속. */
  private readonly cache = new Map<string, boolean>();

  constructor(folder: vscode.WorkspaceFolder) {
    const globs = new Set<string>();
    for (const key of CONFIG_KEYS) {
      const sectionEnd = key.lastIndexOf(".");
      const setting = vscode.workspace
        .getConfiguration(key.slice(0, sectionEnd), folder.uri)
        .get<Record<string, unknown>>(key.slice(sectionEnd + 1));
      for (const [glob, enabled] of Object.entries(setting ?? {})) {
        if (enabled === true) globs.add(glob); // when 절 조건부(files.exclude)는 판정 불가 — 무시
      }
    }
    // windowsPathsNoEscape: VS Code 계열 exclude glob 은 `\` 이스케이프를 쓰지 않는다 —
    // Windows 사용자가 `\` 구분자로 적은 패턴이 조용히 무효화되는 것을 막는다
    this.patterns = [...globs].map(
      (glob) => new Minimatch(glob, { dot: true, windowsPathsNoEscape: true }),
    );
  }

  /** 상위 폴더가 패턴에 걸리면 하위 전체 제외 — 앞에서부터 프리픽스 단위로 판정. */
  isExcluded(relPath: string): boolean {
    let prefix = "";
    for (const segment of relPath.split("/")) {
      prefix = prefix === "" ? segment : `${prefix}/${segment}`;
      let matched = this.cache.get(prefix);
      if (matched === undefined) {
        matched = this.patterns.some((pattern) => pattern.match(prefix));
        this.cache.set(prefix, matched);
      }
      if (matched) return true;
    }
    return false;
  }
}

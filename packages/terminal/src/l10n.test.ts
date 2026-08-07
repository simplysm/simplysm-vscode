import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setL10nBundle, t } from "./l10n.ts";

const packageRootPath = path.dirname(import.meta.dirname);
const sourceRootPath = path.join(packageRootPath, "src");

// 번역을 거친 값만 화면·알림에 넣게 하는 출입구 모듈 — 아래 검사의 대상이 아니라 수단이다.
const gatewayFileNames = new Set(["l10n.ts", "notify.ts", "dom-text.ts", "reason.ts"]);

// 화면·알림에 글자를 직접 넣는 경로 — 출입구를 거치지 않으므로 번역이 빠진 채 사용자에게 닿는다.
const bypassPatterns = [
  { name: "DOM 텍스트 직접 대입", pattern: /\.(?:textContent|innerText|innerHTML)\s*=/ },
  { name: "DOM 표시 속성 직접 대입", pattern: /\.(?:title|placeholder|ariaLabel|label)\s*=/ },
  {
    name: "DOM 표시 속성 setAttribute",
    pattern: /setAttribute\(\s*["'](?:title|placeholder|aria-label)["']/,
  },
  {
    name: "VS Code 알림 직접 호출",
    pattern: /window\.show(?:Information|Warning|Error)Message\(/,
  },
  { name: "VS Code 입력 UI 직접 호출", pattern: /window\.show(?:InputBox|QuickPick)\(/ },
];

function collectScannedSourceFiles(dirPath: string): string[] {
  const filePaths: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...collectScannedSourceFiles(entryPath));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts") &&
      !gatewayFileNames.has(entry.name)
    ) {
      filePaths.push(entryPath);
    }
  }
  return filePaths;
}

function readJsonFile(filePath: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/** 따옴표 종류와 무관하게 문자열 리터럴의 값. 리터럴이 아니면 undefined. */
function literalOf(quoted: string | undefined): string | undefined {
  if (quoted == null) return undefined;
  if (quoted.startsWith('"')) return JSON.parse(quoted) as string;
  return JSON.parse(`"${quoted.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string;
}

/**
 * 소스의 `t(...)`·`reason(...)` 호출 — 첫 인자가 문자열 리터럴이면 그 값, 아니면 undefined.
 * 두 함수 모두 첫 인자가 번역 키가 되므로 함께 모은다.
 */
function collectTranslationCalls(): { filePath: string; message: string | undefined }[] {
  const calls: { filePath: string; message: string | undefined }[] = [];
  for (const filePath of collectScannedSourceFiles(sourceRootPath)) {
    const sourceText = fs.readFileSync(filePath, "utf8");
    for (const match of sourceText.matchAll(
      /\b(?:t|reason)\(\s*(?:("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|([^\s"']))/g,
    )) {
      calls.push({ filePath, message: literalOf(match[1] ?? match[2]) });
    }
  }
  return calls;
}

test("번역 번들이 없으면 영어 원문이 나온다", () => {
  setL10nBundle(undefined);
  assert.equal(t("Open a folder to start a terminal."), "Open a folder to start a terminal.");
});

test("번들에 키가 있으면 번역문이 나온다", () => {
  setL10nBundle({ "Open a folder to start a terminal.": "터미널을 시작하려면 폴더를 여세요." });
  assert.equal(t("Open a folder to start a terminal."), "터미널을 시작하려면 폴더를 여세요.");
  setL10nBundle(undefined);
});

test("번들에 키가 없으면 그 문자열만 영어 원문으로 나온다", () => {
  setL10nBundle({ Translated: "번역됨" });
  assert.equal(t("Untranslated"), "Untranslated");
  setL10nBundle(undefined);
});

test("자리 표시자에 인자가 어순대로 채워진다", () => {
  setL10nBundle({ "{0} exited with code {1}": "코드 {1} 로 {0} 이(가) 끝났습니다" });
  assert.equal(t("{0} exited with code {1}", "pwsh", 1), "코드 1 로 pwsh 이(가) 끝났습니다");
  setL10nBundle(undefined);
});

test("인자가 없는 자리 표시자는 빈 문자열로 바뀌지 않고 그대로 남는다", () => {
  setL10nBundle(undefined);
  assert.equal(t("{0} exited with code {1}", "pwsh"), "pwsh exited with code {1}");
});

test("번역 조회의 첫 인자는 문자열 리터럴이다", () => {
  const dynamicCalls = collectTranslationCalls().filter((call) => call.message == null);
  assert.deepEqual(
    dynamicCalls.map((call) => path.relative(packageRootPath, call.filePath)),
    [],
  );
});

test("조회에 쓰인 문자열과 한국어 카탈로그의 키 집합이 같다", () => {
  const usedMessages = new Set(
    collectTranslationCalls()
      .map((call) => call.message)
      .filter((message) => message != null),
  );
  const catalogKeys = new Set(
    Object.keys(readJsonFile(path.join(packageRootPath, "l10n", "bundle.l10n.ko.json"))),
  );

  assert.deepEqual([...usedMessages].filter((key) => !catalogKeys.has(key)).sort(), []);
  assert.deepEqual([...catalogKeys].filter((key) => !usedMessages.has(key)).sort(), []);
});

test("package.json 이 참조하는 키와 영어·한국어 카탈로그의 키 집합이 같다", () => {
  const manifestText = fs.readFileSync(path.join(packageRootPath, "package.json"), "utf8");
  const referencedKeys = new Set(
    [...manifestText.matchAll(/%([^%"\s]+)%/g)].map((match) => match[1]!),
  );
  const englishKeys = new Set(
    Object.keys(readJsonFile(path.join(packageRootPath, "package.nls.json"))),
  );
  const koreanKeys = new Set(
    Object.keys(readJsonFile(path.join(packageRootPath, "package.nls.ko.json"))),
  );

  assert.deepEqual([...referencedKeys].sort(), [...englishKeys].sort());
  assert.deepEqual([...englishKeys].sort(), [...koreanKeys].sort());
});

test("표시 문자열을 출입구 없이 화면·알림에 넣는 경로가 없다", () => {
  const violations: string[] = [];
  for (const filePath of collectScannedSourceFiles(sourceRootPath)) {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const [lineIndex, lineText] of lines.entries()) {
      for (const { name, pattern } of bypassPatterns) {
        if (pattern.test(lineText)) {
          violations.push(`${path.relative(packageRootPath, filePath)}:${lineIndex + 1} ${name}`);
        }
      }
    }
  }
  assert.deepEqual(violations, []);
});

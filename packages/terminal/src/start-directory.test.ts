import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveStartDirectoryCandidates } from "./start-directory.ts";

const projectRoot = path.resolve("/repo/project");
const toolsRoot = path.resolve("/repo/tools");

test("설정이 없는 폴더는 폴더 경로 자체가 후보가 된다", () => {
  const candidates = resolveStartDirectoryCandidates([{ name: "project", path: projectRoot }]);
  assert.deepEqual(candidates, [{ folderName: "project", path: projectRoot }]);
});

test("폴더별 재정의가 그 폴더의 후보를 바꾼다", () => {
  const candidates = resolveStartDirectoryCandidates([
    { name: "project", path: projectRoot, configuredCwd: path.resolve("/elsewhere") },
    { name: "tools", path: toolsRoot },
  ]);
  assert.deepEqual(candidates, [
    { folderName: "project", path: path.resolve("/elsewhere") },
    { folderName: "tools", path: toolsRoot },
  ]);
});

test("상대 경로는 그 폴더를 기준으로 푼다", () => {
  const candidates = resolveStartDirectoryCandidates([
    { name: "project", path: projectRoot, configuredCwd: "packages/app" },
  ]);
  assert.deepEqual(candidates, [
    { folderName: "project", path: path.join(projectRoot, "packages", "app") },
  ]);
});

test("빈 설정 값은 설정하지 않은 것으로 본다", () => {
  const candidates = resolveStartDirectoryCandidates([
    { name: "project", path: projectRoot, configuredCwd: "" },
  ]);
  assert.deepEqual(candidates, [{ folderName: "project", path: projectRoot }]);
});

test("후보가 한 곳으로 모이면 폴더가 여럿이어도 하나만 남는다", () => {
  const candidates = resolveStartDirectoryCandidates([
    { name: "project", path: projectRoot, configuredCwd: toolsRoot },
    { name: "tools", path: toolsRoot },
  ]);
  assert.deepEqual(candidates, [{ folderName: "project", path: toolsRoot }]);
});

test("폴더를 열지 않은 창에는 후보가 없다", () => {
  assert.deepEqual(resolveStartDirectoryCandidates([]), []);
});

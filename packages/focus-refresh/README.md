# Simplysm Focus Refresh

> 🇰🇷 한국어 설명은 [아래](#한국어-korean)에 있습니다.

Reloads externally changed files when the window regains focus — like WebStorm's "Synchronize files on frame activation".

Edit files with a script, another editor, or `git` while VS Code is in the background, then switch back: without this extension you can keep working on a stale buffer. With it, every open document is checked the moment the window regains focus.

## How it works

- **Clean file changed on disk** → silently reloaded to the disk version. No notification.
- **Dirty file changed on disk (conflict)** → a modal asks you, one file at a time:
  - **Reload from Disk** — load the disk version (your unsaved edits are lost, as the modal warns).
  - **Keep Editor Version** — keep your unsaved edits; the disk is not overwritten. You won't be asked again for that file until the disk changes again.
  - **Show Diff** — open a diff of disk vs editor and decide later (the prompt returns on the next focus if the conflict remains).
- The file Explorer is refreshed as well.

There are no commands, shortcuts, or settings — enable/disable the extension to turn it on/off. English/Korean UI.

---

<details>
<summary id="한국어-korean">한국어 (Korean)</summary>

창이 포커스를 되찾을 때 외부에서 변경된 파일을 다시 불러옵니다 — WebStorm의 "Synchronize files on frame activation"과 같은 동작입니다.

VS Code가 백그라운드에 있는 동안 스크립트, 다른 에디터, `git` 등으로 파일을 수정하고 돌아왔을 때, 이 확장이 없으면 낡은 내용을 보며 계속 작업하게 될 수 있습니다. 이 확장은 창이 포커스를 되찾는 순간 열려 있는 모든 문서를 검사합니다.

### 동작 방식

- **저장된 파일이 디스크에서 변경됨** → 조용히 디스크 버전으로 다시 불러옵니다. 알림 없음.
- **미저장(dirty) 파일이 디스크에서 변경됨 (충돌)** → 파일별로 순차 모달로 묻습니다:
  - **Reload from Disk** — 디스크 버전을 불러옵니다 (모달에 경고되듯 미저장 편집은 사라집니다).
  - **Keep Editor Version** — 미저장 편집을 유지하며, 디스크를 덮어쓰지 않습니다. 디스크가 다시 바뀌기 전까지 그 파일은 다시 묻지 않습니다.
  - **Show Diff** — 디스크 ↔ 에디터 diff를 열고 결정을 미룹니다 (충돌이 남아 있으면 다음 포커스 때 다시 묻습니다).
- 파일 탐색기도 함께 갱신됩니다.

명령·단축키·설정이 없습니다 — 확장 활성/비활성이 곧 on/off입니다. 영어/한국어 UI 지원.

</details>

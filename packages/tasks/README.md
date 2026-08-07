# Simplysm Tasks

A quick list editor for `.tasks` memo files — jot tasks down, delete them when done.

Opening a `.tasks` file shows a dedicated list UI instead of the plain text editor. Every row is always editable — click the task text and type (the handle and the eraser on the left are for reordering and completing, not editing). Done means deleted: erase a task and it is removed (undo brings it back), so there is no checkbox state to manage.

## Features

- **Always-editable rows** — no view/edit mode; click a task and edit in place. Changes are saved the moment you confirm (Enter or leaving the row); no dirty state, no Ctrl+S.
- **Fast entry** — `Enter` saves and starts the next task; `Shift+Enter` (also `Ctrl+Enter` / `Alt+Enter`) adds a line break inside a task; `Esc` reverts the row.
- **Erase to complete** — the eraser in front of each task marks it done, which deletes it. `Ctrl+Z` restores.
- **Groups** — add group headers, rename them in place, drag a whole group (header + tasks), collapse/expand (the collapsed state is saved in the file), and delete a group together with its tasks.
- **Reorder** — drag the handle, or press `Ctrl+Alt+↑/↓` to move a task (or a group, from its name field) one step. Moving across a header changes the task's group. Groups stay below the ungrouped section, so a group cannot move above it.
- **Undo / redo** — `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z`, per confirmed operation, also saved immediately. Inside an edit field these apply to your typing first; when the field is unedited they fall through to document history.
- **External change sync** — edits made outside the editor are picked up immediately, without losing text you are typing.
- **Safe file handling** — unknown JSONL fields are preserved; if a line cannot be parsed, editing is blocked and the error cause is shown with an "Open as Text" shortcut.

Use the **Tasks: New Tasks File** command (also in File > New File…) to create your first `.tasks` file.

## File format

A `.tasks` file is JSONL — one task or group header per line. Tasks after a header belong to that group; tasks before the first header are ungrouped.

```jsonl
{"text":"Ship the release"}
{"group":"In progress"}
{"text":"Write the changelog"}
{"group":"Backlog","collapsed":true}
{"text":"Multi-line\nnotes are fine"}
```

- `{"text":"…"}` — a task. Line breaks are stored as `\n` inside the JSON string.
- `{"group":"…"}` — a group header. Optional `"collapsed":true` keeps the group folded.
- Unknown fields on any line are preserved untouched.

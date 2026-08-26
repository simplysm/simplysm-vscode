# Changelog

## 1.0.6 - 2026-08-26

- Local History: no longer fails with EMFILE when a file has thousands of snapshots

## 1.0.5 - 2026-08-14

- Local History: shift-select a range of snapshots to see their changes merged into one diff

## 1.0.4 - 2026-08-10

- Changelog tab now appears on the extension details page

## 1.0.3 - 2026-08-10

- chore: deploy:local keeps package.json versions untouched (vsix-only bump)
- Drag a tab within the tab bar to reorder it, with an insert line instead of a split preview

## 1.0.2 - 2026-08-10

- Fix garbled multibyte characters when terminal output is split across chunks
- Speed up history browsing by caching snapshots and skip diff for oversized files (rollback still works)

## 1.0.0 - 2026-08-07

Initial release.

- Records local file history automatically
- History view in the Explorer panel
- Restore files or folders to a past state (rollback)
- Show history from the Explorer context menu

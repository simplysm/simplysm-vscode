# Changelog

## 1.0.6 - 2026-08-11

- Split divider now matches VS Code's built-in terminal: a 1px line with a wider grab area, and the terminal body uses the editor background so the active tab blends in

## 1.0.5 - 2026-08-10

- Terminal tab bar scrolls horizontally with the mouse wheel when tabs overflow

## 1.0.4 - 2026-08-10

- Changelog tab now appears on the extension details page

## 1.0.3 - 2026-08-10

- chore: deploy:local keeps package.json versions untouched (vsix-only bump)
- Drag a tab within the tab bar to reorder it, with an insert line instead of a split preview

## 1.0.2 - 2026-08-10

- Fix garbled multibyte characters when terminal output is split across chunks
- Batch terminal output to keep the screen smooth during heavy output

## 1.0.0 - 2026-08-07

Initial release.

- Panel terminal with up to 4-way split — arrange sessions in a grid
- Drag tabs to rearrange sessions
- Shell key shielding (Ctrl+A/B/E/... passed to the shell instead of VS Code)

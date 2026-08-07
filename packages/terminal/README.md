# Simplysm Terminal

A panel terminal you can split into a real 2D grid — arrange sessions by dragging tabs, and keep them alive across window reloads.

The built-in terminal only splits side-by-side within a group. This one treats the panel as a grid: drag a tab to any edge to split vertically or horizontally, drop it on a pane to merge, and drag borders to resize. Shell processes are owned by a detached daemon, so `Developer: Reload Window` (after an extension or settings change) no longer kills your builds and dev servers.

![Grid layout by dragging tabs](images/grid-layout.gif)

## Features

- **Grid layout by drag & drop** — drag a tab to a pane edge to split up/down or left/right, drop on the center to merge; drop targets are previewed while dragging, `Esc` cancels. Borders resize adjacent panes; ratios survive panel resizes.
- **Sessions survive reload** — tabs, names, layout, screen contents, and the *same shell processes* are restored after a window reload. Closing the window for real ends the shells (no ghost processes). If the daemon dies or the extension was updated, sessions are shown as exited with their last screen — nothing pretends to be alive.
- **Shell-first keys** — keys go to the shell by default (`Ctrl+R` history search works); VS Code keeps only what's in `terminal.integrated.commandsToSkipShell`. `Ctrl+F` opens in-terminal search.
- **Session names** — rename a tab in place; the name sticks even before/after the session starts, empty name falls back to the shell name.
- **Start directory** — in a multi-root workspace, each new tab asks which folder to start in.
- **Practical output handling** — `Ctrl+click` file paths to open them in the editor, right-click to copy/paste (copy when text is selected, paste otherwise), `Ctrl+C`/`Ctrl+V` clipboard behavior, OSC 52 support.
- **Native look & feel** — follows your VS Code color theme and terminal font settings live, WebGL rendering, IME-safe (CJK input).
- Requires a trusted workspace (it starts shells in your folders). English/Korean UI.

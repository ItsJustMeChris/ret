# Ret

A fast desktop workbench for [Codex](https://github.com/openai/codex), built for running many projects and tasks at once. Ret drives the official `codex app-server` (the same JSON-RPC engine the Codex IDE extension uses). Models, tools, sandboxing, MCP servers, and your `~/.codex/config.toml` all behave exactly as they do in the CLI.

## Run it

```bash
npm install
npm start          # build + launch the desktop app
npm run dev        # Electron with hot reload (renderer HMR, main/preload auto-restart)
npm run dev:web    # renderer in a browser tab, talking to a local app-server over WebSocket
npm run dist       # Windows installer in release/
```

## Release

Installed copies of Ret update themselves from this repo's GitHub Releases. To ship a version:

```bash
npm version patch          # bumps package.json, commits, tags v<version>
git push --follow-tags     # CI builds the installer and publishes the release
```

Running copies check every 4 hours (or on demand in Settings → Ret), download the update in the background, and ask before restarting into it. If you say *Later*, it installs the next time you quit.

## What you get

**Your ChatGPT subscription.** Ret uses Codex's own login (`~/.codex/auth.json`), so if the Codex CLI is already signed in, so is Ret. If not, you can sign in with ChatGPT in the browser or with a device code. Plan usage (for example the 7-day limit) shows in the sidebar.

**Codex that updates itself.** In *Managed* mode (the default), Ret checks npm for new `@openai/codex` releases (stable or alpha channel) every 2 hours. When it finds one, it:

1. Downloads the platform tarball.
2. Verifies it against the registry's sha512 integrity.
3. Extracts it to `%APPDATA%/ret/codex/versions/<ver>`.
4. Smoke-tests it with `--version`.
5. Swaps it in once no thread is running, so an update never interrupts a turn.

Ret keeps the previous version for rollback. On first launch it starts instantly on any codex you already have installed, then switches to the managed copy once it's ready. *System* and *Custom path* sources are available in Settings.

**Dedicated or shared engine.** By default Ret runs its own app-server. In Settings you can switch to *Shared daemon*, which attaches to the background Codex daemon that the Codex desktop app uses (via `codex app-server proxy`). Threads you run there then stream live into Ret too. In that mode the daemon manages its own codex version.

**Sees work running in other Codex apps.** Every thread from the CLI, the VS Code extension and the Codex app shows in the sidebar. Threads currently running in one of those apps get a spinner and an "elsewhere" status dot. When you open one, its transcript updates every few seconds as it progresses, and you get a notification when it finishes. Replying from Ret is paused until the other app's turn ends, so two processes never write to the same thread at once.

How Ret detects this: each of those apps runs its own private app-server, so Ret polls the shared state database (about 10 ms per check). A turn with no recorded end, in a thread that's still being updated, counts as running.

**Sidebar with projects and fork folders.** Threads are grouped by project folder. When you fork a thread, it becomes a nested folder holding the original and its forks. A fork of a fork nests again.

- Fork the whole conversation from the header, `Ctrl+Shift+F`, or the context menu.
- Fork from any earlier turn with "Fork from here" on that turn.
- Fork into a new git worktree, so parallel experiments don't edit each other's files.

**Two ways to work:**

- **Focus mode.** Browser-style tabs, one thread at full size. A tab can also hold two threads side by side:
  - Forking opens the fork next to the original, with a fork badge on the divider showing which is which.
  - Alt+click a thread (or drag it onto the right half) to open it beside the current one.
  - Ctrl+W closes the focused pane.
- **Canvas mode.** An infinite canvas of thread windows.
  - Drag a window by its title bar or any empty background; text shows an I-beam so it stays easy to select and copy.
  - Resize with edge snapping, maximize, tidy into rows, fit to screen, and keep several named boards. There's a minimap, and you can drag threads in from the sidebar.
  - **Fork links** connect each thread to its forks. Click a link's badge to frame both windows; right-click it to compare them side by side in Focus.
  - **Right-click empty canvas** to start a thread right there (in the current project or any other), open a thread, fit/tidy/zoom, toggle links, or manage boards.
  - Zoomed out past 50%, windows become large, glanceable summary cards.

**Floating sidebar.** The sidebar floats over the content and never resizes it.
- Pin it to keep it open.
- Unpin it (Ctrl+B) and it slides away. It reads your pointer's motion to tell when you're reaching for it:
  - A quick throw toward the left edge opens it before the cursor gets there.
  - Arriving at the edge at speed opens it at once.
  - A slow approach opens after a brief touch of the edge or a short rest beside it.
  - Aiming at something near the edge doesn't open it, and neither does resting on a button or tab there.
  - A faint handle at the edge brightens as the intent builds.
- It tucks away again when you move off. A decisive move away closes it quickly; drifting gets a little grace.

**Links, files and right-click.**
- Web links open in your browser. Right-click a link to open it, copy its address, or copy its text.
- File references in messages (`C:/…`, `/C:/…`, `file://`, `path:line`, `#L12`) are clickable. Code files open in VS Code at that line (if installed); other files open with their default app. Alt+click reveals the file in File Explorer / Finder.
- Right-click a file reference, an edited file, a "Read" or "Searched" path, or a path in `inline code` to open it, reveal it in its folder, or copy its path.
- Programs and binaries (`.exe`, `.dll`, `.ps1`, `.bat`…) are never launched from a link; Ret reveals them in their folder instead.
- Right-click inside text boxes for spelling suggestions and undo / cut / copy / paste / select all, and on selected text to copy it.

**Size-aware windows.** Every thread pane adapts to its own size, not the screen's:

| Window size | What it shows |
| --- | --- |
| Glance (tiny) | Status, last message, and any approval buttons |
| Compact | Transcript with a slim composer |
| Regular | Full transcript |
| Wide | Optional details panel (plan, changed files, tokens, lineage), off by default and toggled from the thread's ⋯ menu |

**Built to stay fast:**

- Streaming events are batched once per animation frame into a copy-on-write store, and each transcript item subscribes only to itself.
- Off-screen turns skip layout (`content-visibility`).
- Canvas pan, zoom, and drag write straight to the DOM, so they never trigger a React render.
- Idle threads that nobody is looking at are unsubscribed from the app-server after 3 minutes.

## Keys

| | |
|---|---|
| `Ctrl K` | Command palette (threads, projects, commands; `Alt+Enter` opens in the other mode) |
| `Ctrl N` | New thread in the current project |
| `Ctrl \` | Toggle Focus / Canvas |
| `Ctrl B` | Pin / unpin the floating sidebar (unpinned: hover the left edge) |
| `Ctrl Shift F` | Fork current thread |
| `Ctrl W` / `Ctrl Tab` / `Ctrl 1–9` | Close (focused pane in a split) / cycle / jump tabs or windows |
| `Alt+click` a thread | Focus: open it beside the current one |
| `Ctrl 0`, `Ctrl ±`, `Ctrl+scroll` | Canvas: fit all, zoom |
| `Space+drag`, middle-drag, scroll | Canvas: pan |
| `Alt+drag` | Move a window without snapping |
| `Esc` (in composer) | Stop the running turn. Typing while a turn runs steers it. |

## Layout

```
src/main/            Electron main: window, IPC, git worktrees
  codex/appServer.ts   spawns `codex app-server`, batches stdout lines to the renderer
  codex/updater.ts     npm-registry self-updater (download → verify → extract → promote)
  codex/platform.ts    binary discovery (managed / npm / bun / brew), version compare
src/preload/         contextBridge → window.ret
src/shared/bridge.ts main ↔ renderer contract
src/renderer/
  rpc/client.ts        JSON-RPC client; re-handshakes on every app-server restart
  protocol/generated/  typings generated by `codex app-server generate-ts` (npm run gen:protocol)
  state/               zustand stores: threads (live), ui (persisted), conn; actions
  components/          sidebar, focus view, canvas, thread pane, composer, approvals…
```

When a codex release changes the protocol, run `npm run gen:protocol` and fix whatever `npm run typecheck` flags.

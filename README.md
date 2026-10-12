# Ret

A desktop app for running lots of [Codex](https://github.com/openai/codex) agents at once, across lots of projects, without losing track of them.

You start threads, fork them, put them side by side or spread them out on a canvas, work through whatever's waiting on you from an inbox, answer their questions and approvals, and read or edit the files they touch in a built-in editor, all in one window. Ret also picks up threads running in the Codex CLI, VS Code and the Codex app, and keeps Codex itself up to date in the background.

It drives the official `codex app-server` (the same JSON-RPC engine the Codex IDE extension uses), so models, tools, sandboxing, MCP servers and your `~/.codex/config.toml` all behave exactly as they do in the CLI.

## Run it

```bash
npm install
npm start          # build + launch the desktop app
npm run dev        # Electron with hot reload (renderer HMR, main/preload auto-restart)
npm run dev:web    # renderer in a browser tab, talking to a local app-server over WebSocket
npm run dist       # Windows installer in release/
npm run dist:mac   # macOS dmg + zip in release/ (on a Mac)
```

App icons live in `build/` (`icon.ico` for Windows, `icon.icns` for macOS, `icon.png` for Linux), generated from `build/icon-source.png` by `python scripts/make-icons.py` (needs Pillow). Re-run it after changing the source art.

## Codex

**Your ChatGPT subscription.** Ret uses Codex's own login (`~/.codex/auth.json`), so if the Codex CLI is already signed in, so is Ret. If not, you can sign in with ChatGPT in the browser or with a device code. Plan usage (for example the 7-day limit) shows in the sidebar.

**Codex that updates itself.** In *Managed* mode (the default), Ret checks npm for new `@openai/codex` releases (stable or alpha channel) every 2 hours. When it finds one, it:

1. Downloads the platform tarball.
2. Verifies it against the registry's sha512 integrity.
3. Extracts it to `%APPDATA%/ret/codex/versions/<ver>`.
4. Smoke-tests it with `--version`.
5. Swaps it in once no thread is running, so an update never interrupts a turn.

Ret keeps the previous version for rollback. On first launch it starts instantly on any codex you already have installed, then switches to the managed copy once it's ready. *System* and *Custom path* sources are available in Settings.

**Dedicated or shared engine.** By default Ret runs its own app-server. In Settings you can switch to *Shared daemon*, which attaches to the background Codex daemon that the Codex desktop app uses (via `codex app-server proxy`). Threads you run there then stream live into Ret too. In that mode the daemon manages its own codex version.

## Threads

**Sees work running in other Codex apps.** Every thread from the CLI, the VS Code extension and the Codex app shows in the sidebar. Threads currently running in one of those apps get a spinner and an "elsewhere" status dot. When you open one, its transcript updates every few seconds as it progresses, and you get a notification when it finishes. Replying from Ret is paused until the other app's turn ends, so two processes never write to the same thread at once.

How Ret detects this: each of those apps runs its own private app-server, so Ret polls the shared state database (about 10 ms per check). A turn with no recorded end, in a thread that's still being updated, counts as running.

**Steer, queue, stop.**
- Enter while a turn is running steers it.
- Ctrl+Enter queues the message for after the turn instead. Queued messages sit in a tray above the composer, where you can push one into the running turn now, pull it back to edit, or drop it.
- Esc stops the turn.

**Approvals.** When Codex wants to run a command, apply an edit or get more access, the request shows in the thread: allow it once, allow it for the session (or always allow that command), decline, or stop the turn. You get a notification if the thread isn't on screen, and it shows up in the Inbox.

**Plan mode.** Turn on Plan in the composer (or press Shift+Tab, as in Codex) and Codex thinks the task through before changing anything: it can stop to ask you questions, then proposes a plan with an "Implement this plan" button.

**Questions.** When Codex asks something, whether it stopped to ask in Plan mode, asked while it keeps working, or left questions at the end of a reply, the question docks on top of the composer.
- Pick an answer with a click or its number key, or with ↑/↓ and Enter. To write your own, pick "Other" (or just start typing when there are no options) and send it from the box as usual. Esc backs out of "Other".
- Several questions go one at a time, with Back to change an earlier answer; the last one sends them all.
- Answers to a request go straight back to Codex. Answers to questions in a message go back as your next message, steering the turn if it's still running.
- Skip lets Codex carry on without an answer. Questions in a message can be closed instead; they stay in the conversation with an "Answer this" link to bring them back.
- Secret answers get their own hidden field and never touch the composer or its saved drafts.

**Turn rail.** Hover the left edge of a transcript for a rail of its turns. The ticks spread out around the pointer so they stay easy to hit on long threads; hovering previews a turn and clicking scrolls to it.

## Projects and forks

Threads are grouped by project folder. When you fork a thread, it becomes a nested folder holding the original and its forks. A fork of a fork nests again.

- Fork the whole conversation from the header, `Ctrl+Shift+F`, or the context menu.
- Fork from any earlier turn with "Fork from here" on that turn.
- Select text in a turn and right-click → "Fork with selection" to fork there with that text quoted in the new composer.
- Fork into a new git worktree, so parallel experiments don't edit each other's files.

## Files and images

**Links, files and right-click.**
- Web links open in your browser. Right-click a link to open it, copy its address, or copy its text.
- File references are clickable: links and paths in replies (`C:/…`, `/C:/…`, `file://`, `path:line`, `#L12`, paths written as code), and paths in tool steps, edits and attachments. A file opens as a view of its own next to the thread you clicked it in: the other side of a split in Focus mode, a window beside the thread on the canvas. It's shown in Monaco (the editor inside VS Code) at that line, with syntax highlighting, find (Ctrl+F), folding, sticky scroll and a minimap; read-only until you choose Edit, Ctrl+S saves, and unsaved edits survive switching away. Images open in the image viewer, folders in the file manager, other files with their default app.
- Ctrl+click opens a file in VS Code at that line (if installed) or its default app; Alt+click reveals it in File Explorer / Finder.
- Right-click a file reference, an edited file, a "Read" or "Searched" path, or a path in `inline code` to open it, reveal it in its folder, or copy its path.
- Programs and binaries (`.exe`, `.dll`, `.ps1`, `.bat`…) are never launched from a link; Ret reveals them in their folder instead.
- Right-click inside text boxes for spelling suggestions and undo / cut / copy / paste / select all, and on selected text to copy it.

**Images and dropped files.**
- Images show in threads: ones you attach, files the agent looks at (also as thumbnails on folded steps), and local images in its replies. Click one to see it full size, with open, reveal and copy-path buttons.
- Remote images in the agent's replies stay links instead of loading on their own.
- Drop files anywhere on a thread (or paste them): PNG, JPEG, GIF and WebP images are attached, other files and folders go into your message as paths (relative to the project when inside it).

## Focus, Canvas, Code and Inbox

Four ways to look at the same work; switch with the title bar or Alt+1…4.

- **Focus mode.** Browser-style tabs, one thread at full size. A tab can also hold two threads side by side:
  - Forking opens the fork next to the original, with a fork badge on the divider showing which is which.
  - Alt+click a thread (or drag it onto the right half) to open it beside the current one.
  - Ctrl+W closes the focused pane.
- **Canvas mode.** An infinite canvas of thread windows.
  - Drag a window by its title bar or any empty background; text shows an I-beam so it stays easy to select and copy.
  - Shift+click or Shift+drag a box to select several windows, then drag them together.
  - Resize with edge snapping, maximize, tidy into rows, fit to screen, and keep several named boards. There's a minimap, and you can drag threads in from the sidebar.
  - **Fork links** connect each thread to its forks. Click a link's badge to frame both windows; right-click it to compare them side by side in Focus.
  - **Right-click empty canvas** to start a thread right there (in the current project or any other), open a thread, fit/tidy/zoom, toggle links, or manage boards.
  - Windows off screen that need input, finished without you seeing them, failed, or are still working get a marker on the edge of the view pointing at them. Click it to jump there. The minimap shows the same states.
  - Zoomed out past 50%, windows become large, glanceable summary cards.
- **Code mode.** Like VS Code with Codex beside it: the project's files on the left, open files in editor tabs in the middle (Monaco), and one of the project's threads on the right to talk to.
  - Files the thread added, changed or deleted are marked in the tree (A / M / D), and folders holding changes get a dot.
  - Open files are live: when Codex (or anything else) changes one on disk, it reloads in place and the changed lines flash. If you have unsaved edits it asks first: take the new version, or keep yours.
  - Clicking a file anywhere (in the chat, the tree, a thread in another mode) opens it here. Ctrl+W closes the tab, Ctrl+Tab cycles.
- **Inbox mode.** Everything that wants you, across every project: **Needs you** (questions and approvals), **Ready to review** (finished while you were elsewhere), **Failed**, and **Working**.
  - Each row shows what's being asked, or the latest reply. The thread opens on the right to read, answer or reply.
  - j/k or ↑/↓ move between items; e marks one done. Like email, things you've read stay listed (dimmed) until you clear them.
  - The title bar's Inbox button shows how many need you.
- **Code and Inbox as canvas windows.** Drag the title bar's Code or Inbox button onto the canvas, or right-click empty canvas, and that whole view becomes a window next to your threads, like apps on a desktop.
  - There's one of each; dropping it again moves it.
  - While a Code window is open, files you click anywhere on the canvas open in its tabs.
  - The Inbox window's j/k/e keys only work while that window is focused.

**Size-aware windows.** Every thread pane adapts to its own size, not the screen's:

| Window size | What it shows |
| --- | --- |
| Glance (tiny) | Status, last message, and any approval buttons |
| Compact | Transcript with a slim composer |
| Regular | Full transcript |
| Wide | Optional details panel (plan, changed files, tokens, lineage), off by default and toggled from the thread's ⋯ menu |

**Floating sidebar.** The sidebar floats over the content and never resizes it.
- Pin it to keep it open.
- Unpin it (Ctrl+B) and it slides away. It reads your pointer's motion to tell when you're reaching for it:
  - A quick throw toward the left edge opens it before the cursor gets there.
  - Arriving at the edge at speed opens it at once.
  - A slow approach opens after a brief touch of the edge or a short rest beside it.
  - Aiming at something near the edge doesn't open it, and neither does resting on a button or tab there.
  - A faint handle at the edge brightens as the intent builds.
- It tucks away again when you move off. A decisive move away closes it quickly; drifting gets a little grace.

## Performance

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
| `Alt 1` … `Alt 4` | Focus, Canvas, Code, Inbox |
| `Ctrl B` | Pin / unpin the floating sidebar (unpinned: hover the left edge) |
| `Ctrl Shift F` | Fork current thread |
| `Ctrl W` / `Ctrl Tab` / `Ctrl 1–9` | Close (focused pane in a split) / cycle / jump tabs or windows |
| `Alt+click` a thread | Focus: open it beside the current one |
| `Enter` / `Ctrl Enter` | While a turn runs: steer it / queue for after it |
| `Esc` (in composer) | Stop the running turn |
| `Shift Tab` (in composer) | Toggle Plan mode |
| `1–9`, `↑ ↓ Enter` (question open, box empty) | Pick an answer |
| `j` / `k` or `↑` / `↓`, `e` | Inbox: move between items, mark one done |
| `Ctrl 0`, `Ctrl ±`, `Ctrl+scroll` | Canvas: fit all, zoom |
| `Space+drag`, middle-drag, scroll | Canvas: pan |
| `Shift+click`, `Shift+drag` | Canvas: select several windows |
| `Alt+drag` | Move a window without snapping |

## Release

Installed copies of Ret update themselves from this repo's GitHub Releases. To ship a version:

```bash
npm version patch          # bumps package.json, commits, tags v<version>
git push --follow-tags     # CI builds Windows + macOS and publishes the release
```

The macOS build is signed and notarized, which needs these repository secrets: `CSC_LINK` (base64 Developer ID Application `.p12`), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.

Running copies check every 4 hours (or on demand in Settings → Ret), download the update in the background, and ask before restarting into it. If you say *Later*, it installs the next time you quit.

## Source layout

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
  components/          sidebar, focus view, canvas, code view, inbox, thread pane, composer, approvals…
```

When a codex release changes the protocol, run `npm run gen:protocol` and fix whatever `npm run typecheck` flags.

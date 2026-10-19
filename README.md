<img src="build/icon.png" width="88" alt="" />

# Ret

A desktop app for running lots of coding agents at once, [Codex](https://github.com/openai/codex), [Claude Code](https://claude.com/claude-code), [OpenCode](https://opencode.ai), or any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (Gemini CLI, Goose, Copilot…), across all your projects, without losing track of them.

**[getret.app](https://getret.app)** · [Download](https://github.com/ItsJustMeChris/ret/releases/latest)

Ret runs the official agents with your own sign-ins and settings, and keeps itself and Codex up to date.

## Run it

```bash
npm install
npm run dev        # run with hot reload
npm start          # build and launch
npm run dist       # Windows installer → release/
npm run dist:mac   # macOS dmg + zip → release/ (on a Mac)
```

## Layout

```
src/main/       Electron main process, the Codex, Claude Code and ACP (OpenCode, custom agent) engines, and remote access (remote/)
src/renderer/   the UI (demo/ is the website's in-browser version)
src/shared/     what both sides share, including the agent protocol
apps/mobile/    Ret for iPhone and Android: pairs with a desktop Ret and uses its agents (see its README)
site/           getret.app
```

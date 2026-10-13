<img src="build/icon.png" width="88" alt="" />

# Ret

A desktop app for running lots of coding agents at once, [Codex](https://github.com/openai/codex) and [Claude Code](https://claude.com/claude-code), across all your projects, without losing track of them.

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

App icons are generated from `build/icon-source.png` with `python scripts/make-icons.py`.

## Release

```bash
npm version patch          # bump the version and tag it
git push --follow-tags     # CI builds Windows + macOS and publishes the release
```

Installed copies update themselves from the release. Signing the macOS build needs these repository secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`.

## Website

`site/` is getret.app. Its hero embeds the real app, built from `src/renderer` by `npm run build:demo`. It deploys with `site/Dockerfile`, built from the repo root, and the tour video lives on `cdn.getret.app`.

## Layout

```
src/main/       Electron main process, and the Codex and Claude Code engines
src/renderer/   the UI (demo/ is the website's in-browser version)
src/shared/     what both sides share, including the agent protocol
site/           getret.app
promo/          the launch video
```

When a Codex release changes the protocol, run `npm run gen:protocol` and fix what `npm run typecheck` flags.

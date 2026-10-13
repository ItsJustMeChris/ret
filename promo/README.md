# Ret promo video

A 56-second, 1080p/30fps launch video for Ret, built with [Remotion](https://www.remotion.dev). Everything is drawn in React from Ret's own design tokens (true-black theme, `#8b9cff` accent, Inter, lucide icons), and the mascot is a vector redraw of `build/icon-source.png`, so it can blink and wiggle its antennae. There are no screenshots, so no private threads end up in it.

```bash
npm install
curl --create-dirs -o public/soundtrack.wav https://cdn.getret.app/soundtrack.wav   # the soundtrack isn't in git
npm run studio                    # live preview and scrubbing
npm run render                    # → out/ret-promo.mp4
python scripts/soundtrack.py      # regenerate public/soundtrack.wav instead (numpy + scipy)
node scripts/stills.mjs 300 700   # half-size review stills of given frames → out/
```

## Timeline

| Frames | Scene | File |
| --- | --- | --- |
| 0–160 | "One agent is easy. Ten is chaos." Terminals pile up, then collapse | `scenes/Chaos.tsx` |
| 150–270 | Logo lockup | `scenes/Logo.tsx` |
| 260–560 | Canvas: windows, a fork link, status dots, beacon, minimap | `scenes/Canvas.tsx` |
| 550–780 | Approval card clicked, question answered with a key | `scenes/Approve.tsx` |
| 770–980 | Inbox triage with j / e | `scenes/InboxScene.tsx` |
| 970–1160 | Fork from here, then a side-by-side worktree split | `scenes/Fork.tsx` |
| 1150–1340 | Codex and Claude Code feature parity | `scenes/Agents.tsx` |
| 1330–1500 | Focus / Canvas / Code / Inbox | `scenes/Modes.tsx` |
| 1490–1690 | Outro and call to action | `scenes/Outro.tsx` |

Scene lengths live in `src/Promo.tsx` (scenes overlap by 10 frames and crossfade). The soundtrack is synthesized from scratch and cued to those frames. If you retime a scene, update the matching frame numbers in `scripts/soundtrack.py` and regenerate it.

The rendered video is published at https://cdn.getret.app/ret-promo.mp4, which getret.app's tour plays. Re-upload `out/ret-promo.mp4` there after a new render.

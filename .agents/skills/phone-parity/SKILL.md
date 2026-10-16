---
name: phone-parity
description: Keep Ret for iPhone and Android (apps/mobile) in step with the desktop app after a change. Finds what a desktop change means for the phone (shared logic it already gets, screens and motion it needs ported, bridge methods it lacks, palette tokens to regenerate), ports it so the phone works, looks, moves and reads like the desktop, and reports what's ported, shared or desktop-only. Use after any change under src/renderer or src/shared that a person sees or does (transcripts, composer, approvals, inbox, status, animations, wording, colors, new bridge calls), before committing such a change, and whenever asked to "do the same on the phone", check mobile, or keep the apps consistent, even when the phone isn't mentioned.
---

# Phone parity

The phone app runs the desktop renderer's own logic (stores, actions, helpers, agent descriptions:
imported as `@ret/…` and `@shared/…`, see apps/mobile/README.md) and draws its own native screens
with the desktop's palette. So a desktop change can reach the phone in three ways: by itself (logic
it already shares), by a port (a component, a style, a motion redrawn natively), or not at all
(it only makes sense on a desktop). The user wants the phone to match the desktop in what it does
and how it feels: the same words, colors, states and motion, adapted to a finger and a small
screen. Drift happens when a change lands only in a desktop component or app.css, so check every
change that people can see or use.

The skill lives in `.agents/skills/phone-parity/`. This file is also at
`.claude/skills/phone-parity/SKILL.md`, for Claude Code: the two are kept the same.

## Workflow

1. **Scope.** List what changed: `git diff --stat` for the working tree, or
   `git diff <base>...<head> --stat` for a branch. Read every changed file under `src/renderer` and
   `src/shared`, and sort each change into one of the kinds below.

2. **Sort each change.**
   - **Shared logic** (`src/renderer/state`, `src/renderer/lib`, `src/renderer/agents`,
     `src/shared`, hooks such as `components/StatusDot`'s or `components/thread/useWork`): the phone
     runs it as it is. Check that it stays free of the DOM (`window`, `document`, `matchMedia`, CSS,
     `Element`): the phone has none, and the failure only shows when the phone runs that code.
   - **A desktop component** (`src/renderer/components/**`): find its phone counterpart (map below)
     and port what a person sees or does. If the component holds logic (working out a state,
     choosing words), move that logic into a hook or lib module both sides import, and port only
     the drawing. RetBot is the pattern: `lib/working.ts` (kinds, moods, verbs, labels),
     `components/thread/useWork.ts` (the hook), `lib/retBot.ts` (shapes), and a component on each
     side.
   - **Styles** (`src/renderer/styles/app.css`): a palette change → `npm run tokens` in apps/mobile
     (`npm test` fails while `src/theme.css` is stale). Spacing, sizes and motion don't carry over by
     themselves: port them to the counterpart.
   - **The bridge** (`src/shared/bridge.ts`, `src/renderer/bridge.ts`): shared code that calls a new
     bridge method needs it in the phone's bridge (`apps/mobile/src/platform/createBridge.ts`), or
     it fails only on the phone (6913c64: `files.visualization`).
   - **Desktop-only by nature**: the canvas, Code mode's editor, the title bar and windows, keyboard
     shortcuts, hover cards, the updater, hosting remote access. Leave them, and say so in the report.

3. **Port it so it feels the same.**
   - **Words**: labels, verbs, empty states and errors come from the same constants, never retyped.
   - **Colors**: Uniwind classes named after the desktop's tokens (`bg-bg-2`, `text-text-3`,
     `accent-*` for icon colors); `useCSSVariable(["--color-accent", …])` where a raw value is needed
     (SVG fills).
   - **Motion**: the desktop animates `transform` and `opacity` only, on the compositor (perf-review
     rules 3.2). On the phone, use Reanimated 4's CSS animations (`animationName` keyframe objects
     on an `Animated.View`, run on the UI thread) with the same keyframes, durations and easings.
     Keyframes in percentages of a glyph become pixels from its known size. Reduced motion: the
     desktop's media query, the phone's `useReducedMotion()`; both keep resting poses.
   - **Size**: phone text is larger (14 px body and 13 px muted, where the desktop has 12.5 and 12),
     so scale glyphs to match (RetBot: 18 px on the desktop, 20 on the phone).
   - **Touch**: hover affordances become presses, long presses or always-visible controls; tooltips
     become `accessibilityLabel`s; menus become sheets (`src/ui/Sheet.tsx`).
   - **Point both ways**: say in a comment on each side where its twin is ("as the desktop's X",
     "the phone's … moves the same way: change both"), as the code already does. That is what the
     next change finds.

4. **Check.**
   - Desktop: `npm run typecheck` at the root; see it in the `ret-demo` preview.
   - Phone, in apps/mobile: `npm run typecheck`, `npm run lint`, `npm test` (tokens up to date;
     stores and protocol against the desktop's code). This needs its node_modules: `npm install`
     with a Uniwind Pro login (README). On a machine without one, `npm ci --ignore-scripts` is enough
     for `npx tsc --noEmit` (every `className` then fails to type, and `uniwind` doesn't resolve:
     judge only the other errors). `test/run.mjs` bundles into POSIX-style paths: run the tests on
     macOS or Linux. To see it, run a simulator against `node test/serve.mjs` (a test desktop with
     the demo's scripted agents).
   - Say plainly what couldn't be run (no simulator, no Pro login) rather than implying it was.

5. **Report**, after the change's own summary:

   ```
   **Phone parity**
   | desktop change | phone |
   | ... | ported (file) / shared, nothing to do / desktop-only: why / gap left: why, follow-up |
   Checked: <what ran on each side>. Not checked: <what didn't, and why>.
   ```

## Where things are

| Desktop (src/renderer) | Phone (apps/mobile/src) |
|---|---|
| components/thread/ThreadPane.tsx | app/thread/[id].tsx |
| components/thread/Transcript.tsx (turns, Working row) | thread/Transcript.tsx |
| components/thread/Items.tsx | thread/Items.tsx |
| components/thread/Composer.tsx | thread/Composer.tsx |
| components/thread/ModelTuner.tsx + app.css `.tuner-*` (logic in lib/effortMeter) | thread/ModelTuner.tsx |
| components/thread/Approvals.tsx, Questions | thread/Approvals.tsx |
| components/ui/RetBot.tsx + app.css `.retbot` | ui/RetBot.tsx |
| components/StatusDot.tsx (state logic shared) | ui/StatusDot.tsx |
| components/inbox/InboxView.tsx | app/(tabs)/index.tsx |
| components/Sidebar.tsx (projects) | app/(tabs)/projects.tsx |
| components/Settings.tsx, RemoteAccess.tsx | app/(tabs)/settings.tsx, app/pair.tsx |
| Code mode's explorer and files | app/files.tsx, app/file.tsx |
| components/Markdown.tsx | ui/Markdown.tsx |
| components/thread/ThreadImage.tsx | ui/ThreadImage.tsx |
| components/Toasts.tsx | ui/Toasts.tsx |
| Select menus | ui/Sheet.tsx |
| app.css `.btn`, `.badge`, inbox rows | ui/primitives.tsx |
| app.css palette (`[data-theme]`) | theme.css (generated: `npm run tokens`) |
| src/renderer/bridge.ts | platform/bridge.ts, platform/createBridge.ts |
| src/renderer/main.tsx (store start-up) | app/_layout.tsx |

Without a row (a new desktop part, such as the Dynamic Island, the goal bar, the queue tray or the
subagent tray): decide whether the phone should have it. Port it, or name it as a gap in the report.

## Known differences

These were true when this was written; check before relying on them, and update this list when one
closes or a new one is chosen on purpose.

- The desktop's "Waiting on background work" section (the dozing bot and its task list) is a badge on
  the phone.
- Text shimmers on the desktop (the Working verb, "Thinking"); the phone pulses "Thinking" and
  shows the Working verb plainly (it has no masked view for a shimmer).
- The phone has no canvas, Code-mode editor, command palette or keyboard shortcuts, by design.
- The model tuner: the desktop previews an effort while the pointer hovers its bars, and swaps its
  popover to the model list in place; the phone has no hover (a tap or drag sets it, with a haptic
  tick per step), and its model list is a sheet of its own that hands back to the tuner.

## Maintaining this skill

Edit this file in `.agents/skills/phone-parity/` and copy it over the one in
`.claude/skills/phone-parity/` (`cmp` the two to check). Add rows to the map as screens appear, and
keep "Known differences" current.

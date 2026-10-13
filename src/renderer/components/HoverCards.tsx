import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { File as FileIcon, FileCode2, FileQuestion, Folder, GitBranch, GitFork, Globe, Mail, ShieldAlert } from "lucide-react";
import { bridge, isDesktop } from "../bridge";
import { NOT_TEXT, looksLikePath, parseFileRef, resolvePath, revealLabel } from "../lib/files";
import { RUNNABLE } from "../../shared/files";
import { useThreads } from "../state/threads";
import { useConn } from "../state/conn";
import { threadTitle } from "../state/projects";
import { plainText, timeAgo } from "../lib/format";
import { backgroundLabel, STATE_LABEL, useBackgroundOnly, useRunsElsewhere, useThreadState } from "./StatusDot";
import type { EngineStatus, ProviderId, UpdaterState } from "../../shared/bridge";
import { PROVIDERS } from "../agents";

const DELAY = 500;
/** After a card closes, moving onto another card target within this window shows it at once. */
const WARM_MS = 400;
const GAP = 8;

/** Everything that gets a hover card (plain `title` tooltips inside these are suppressed). */
export const CARD_TARGETS = "[data-card], a[href], [data-path], .md code";

type Card =
  | { kind: "thread"; id: string; forks: number }
  | { kind: "engine"; provider: ProviderId }
  | { kind: "url"; href: string; note: string | null }
  | { kind: "file"; path: string; line?: number; col?: number; cwd: string | null; clickable: boolean };

/** What card, if any, an element under the pointer should show. */
function classify(el: HTMLElement): Card | null {
  if (el.dataset.card === "thread" && el.dataset.id) return { kind: "thread", id: el.dataset.id, forks: Number(el.dataset.forks) || 0 };
  if (el.dataset.card === "engine") return { kind: "engine", provider: (el.dataset.provider as ProviderId) ?? "codex" };
  const cwd = el.closest("[data-cwd]")?.getAttribute("data-cwd") ?? null;
  if (el.dataset.path) {
    const n = (v?: string) => Number(v) || undefined;
    return { kind: "file", path: el.dataset.path, line: n(el.dataset.line), col: n(el.dataset.col), cwd, clickable: el.matches("a.file-link") || (!!el.closest(".transcript") && !el.closest(".thread-img")) };
  }
  const href = el.getAttribute("href");
  if (el.tagName === "A" && href && /^(https?:|mailto:)/i.test(href)) {
    const note = el.getAttribute("data-tip") ?? el.getAttribute("title");
    return { kind: "url", href, note: note && note !== href ? note : null };
  }
  // `path/to/file.ts:12` written as inline code in a message.
  if (el.tagName === "CODE" && !el.closest("pre")) {
    const text = el.textContent ?? "";
    const ref = looksLikePath(text) ? parseFileRef(text) : null;
    if (ref) return { kind: "file", ...ref, cwd, clickable: false };
  }
  return null;
}

/** The nearest card target around `start` (a code span inside a link falls through to the link). */
function cardFor(start: Element | null): { el: HTMLElement; card: Card } | null {
  let cur = start;
  while (cur) {
    const el = cur.closest<HTMLElement>(CARD_TARGETS);
    if (!el) return null;
    const card = classify(el);
    if (card) return { el, card };
    cur = el.parentElement;
  }
  return null;
}

/**
 * Rich hover cards, after a short delay: threads and the codex badge (`data-card`), web links,
 * and file references (`data-path`, file links, and paths written as inline code). Cards for
 * things in the sidebar sit beside it; everything else gets the card just below (or above) it.
 */
export function HoverCardHost() {
  const [card, setCard] = useState<{ el: HTMLElement; card: Card } | null>(null);

  useEffect(() => {
    let timer = 0;
    let pending: HTMLElement | null = null;
    let shown: HTMLElement | null = null;
    let closedAt = 0;

    const hide = () => {
      clearTimeout(timer);
      pending = null;
      if (shown) closedAt = performance.now();
      shown = null;
      setCard(null);
    };

    const onOver = (e: PointerEvent) => {
      if (e.buttons) return;
      const hit = cardFor(e.target as Element | null);
      const el = hit?.el ?? null;
      if (el === pending || el === shown) return;
      if (!hit || !el) return;
      const warm = !!shown || performance.now() - closedAt < WARM_MS;
      hide();
      pending = el;
      const show = () => {
        if (pending !== el || !el.isConnected || el.closest("[inert]")) return;
        shown = el;
        pending = null;
        setCard(hit);
      };
      if (warm) show();
      else timer = window.setTimeout(show, DELAY);
    };

    const onOut = (e: PointerEvent) => {
      const target = shown ?? pending;
      if (target && !target.contains(e.relatedTarget as Node | null)) hide();
    };

    window.addEventListener("pointerover", onOver, true);
    window.addEventListener("pointerout", onOut, true);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", hide, true);
    window.addEventListener("wheel", hide, { capture: true, passive: true });
    window.addEventListener("dragstart", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerover", onOver, true);
      window.removeEventListener("pointerout", onOut, true);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", hide, true);
      window.removeEventListener("wheel", hide, true);
      window.removeEventListener("dragstart", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!card) return null;
  const c = card.card;
  const body =
    c.kind === "thread" ? (
      <ThreadCard id={c.id} forks={c.forks} />
    ) : c.kind === "engine" ? (
      <EngineCard provider={c.provider} />
    ) : c.kind === "url" ? (
      <UrlCard href={c.href} note={c.note} />
    ) : (
      <FileCard {...c} />
    );
  const compact = c.kind === "url" || c.kind === "file";
  return createPortal(
    <Placed anchor={card.el} compact={compact}>
      {body}
    </Placed>,
    document.body,
  );
}

/**
 * Positions the card and keeps it on screen. In the sidebar it sits just outside the sidebar,
 * level with the row, so it never covers the list; elsewhere it goes below the anchor (above
 * when there's no room), left-aligned with it.
 */
function Placed({ anchor, compact, children }: { anchor: HTMLElement; compact: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const card = ref.current;
      if (!card) return;
      const a = anchor.getBoundingClientRect();
      const w = card.offsetWidth, h = card.offsetHeight;
      const maxLeft = window.innerWidth - w - GAP, maxTop = window.innerHeight - h - GAP;
      const side = anchor.closest(".sidebar-layer")?.getBoundingClientRect();
      if (side) {
        setPos({ left: Math.min(side.right + GAP, maxLeft), top: Math.max(GAP, Math.min(a.top - 6, maxTop)) });
        return;
      }
      const below = a.bottom + 6;
      const top = below <= maxTop || a.top - 6 - h < GAP ? Math.min(below, maxTop) : a.top - 6 - h;
      setPos({ left: Math.max(GAP, Math.min(a.left - 4, maxLeft)), top: Math.max(GAP, top) });
    };
    place();
    const ro = new ResizeObserver(place);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [anchor]);

  return (
    <div
      ref={ref}
      className={`hover-card ${compact ? "compact" : ""}`}
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Link and file cards
// ---------------------------------------------------------------------------

function UrlCard({ href, note }: { href: string; note: string | null }) {
  if (/^mailto:/i.test(href)) {
    return (
      <div className="hc-link">
        <div className="hc-link-head">
          <Mail size={13} />
          <span className="hc-link-host">{decodeURIComponent(href.slice(7).split("?")[0])}</span>
        </div>
        <div className="hc-hint">Click to write an email · Right-click to copy the address</div>
      </div>
    );
  }
  let host = href, rest = "", secure = true;
  try {
    const u = new URL(href);
    host = u.host.replace(/^www\./, "");
    rest = decodeURI(`${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`);
    secure = u.protocol === "https:";
  } catch {
    /* show it raw */
  }
  return (
    <div className="hc-link">
      {note && <div className="hc-link-note">{note}</div>}
      <div className="hc-link-head">
        {secure ? <Globe size={13} /> : <ShieldAlert size={13} className="st-warn" />}
        <span className="hc-link-host">{host}</span>
        {!secure && <span className="hc-pill warn">Not secure</span>}
      </div>
      {rest && <div className="hc-link-path mono">{rest}</div>}
      <div className="hc-hint">Click to open in your browser · Right-click to copy</div>
    </div>
  );
}

const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** `dir` relative to the project folder ("src/lib/"), or null when it's outside it. */
function relativeDir(dir: string, cwd: string | null): string | null {
  if (!cwd) return null;
  const d = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const c = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (d.toLowerCase() === c.toLowerCase()) return "./";
  if (d.toLowerCase().startsWith(c.toLowerCase() + "/")) return d.slice(c.length + 1) + "/";
  return null;
}

function FileCard({ path, line, col, cwd, clickable }: { path: string; line?: number; col?: number; cwd: string | null; clickable: boolean }) {
  const abs = resolvePath(path, cwd);
  // What's actually there decides what a click does (desktop only: the web build can't look).
  const [info, setInfo] = useState<{ exists: boolean; isDir: boolean; editor: boolean } | null>(null);
  useEffect(() => {
    if (!isDesktop) return;
    let live = true;
    void Promise.all([bridge.files.stat(abs), bridge.editor.available()]).then(([st, editor]) => live && setInfo({ ...st, editor }));
    return () => {
      live = false;
    };
  }, [abs]);

  const name = basename(abs);
  const dirPath = abs.slice(0, abs.length - name.length).replace(/[\\/]+$/, "");
  const dir = relativeDir(dirPath, cwd) ?? displayPath(dirPath, 60);
  const missing = info && !info.exists;
  const isDir = !!info?.isDir;
  const Icon = missing ? FileQuestion : isDir ? Folder : NOT_TEXT.test(name) ? FileIcon : FileCode2;

  const reveal = revealLabel.charAt(0).toLowerCase() + revealLabel.slice(1); // "reveal in File Explorer"
  // Mirrors viewFile: text and code open in Ret's viewer, images in the image viewer, the rest
  // with their app (programs are only ever revealed).
  const external = info?.editor && !NOT_TEXT.test(name) ? "VS Code" : "its app";
  let action: string;
  if (!clickable) action = `Right-click to view, open, ${reveal} or copy`;
  else if (isDir) action = `Click to open the folder · Alt+click to ${reveal}`;
  else if (RUNNABLE.test(name) && NOT_TEXT.test(name)) action = `Click to ${reveal} (programs are never run)`;
  else if (NOT_TEXT.test(name)) action = `Click to open · Alt+click to ${reveal}`;
  else action = `Click to view${line ? ` at line ${line}` : ""} · Ctrl+click for ${external} · Alt+click to ${reveal}`;

  return (
    <div className="hc-link">
      <div className="hc-link-head">
        <Icon size={13} className={missing ? "st-err" : undefined} />
        <span className="hc-link-host">{name}</span>
        {line ? <span className="hc-chip">line {line}{col ? `:${col}` : ""}</span> : null}
        {missing && <span className="hc-pill bad">Not found</span>}
      </div>
      {dir && <div className="hc-link-path mono">{dir}</div>}
      <div className="hc-hint">{action}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread card
// ---------------------------------------------------------------------------

const ORIGINATORS: Record<string, string> = {
  ret: "Ret",
  claude_code: "Claude Code",
  "Codex Desktop": "Codex app",
  codex_work_desktop: "Codex app",
  "codex-tui": "Codex CLI",
  codex_cli_rs: "Codex CLI",
  codex_exec: "codex exec",
  codex_vscode: "VS Code",
};

function originLabel(originator: string | null, source: unknown): string | null {
  if (originator) {
    const known = ORIGINATORS[originator];
    if (known) return known;
    // Unknown client ids ("some_client-name") read better as words.
    const words = originator.replace(/[_-]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  if (source === "vscode") return "VS Code";
  if (source === "cli") return "Codex CLI";
  if (source === "exec") return "codex exec";
  return null;
}

/** Flatten a (possibly huge, pasted) first message into a few readable lines. */
function previewText(raw: string): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  return flat(plainText(raw.slice(0, 4000), 360)) || flat(raw.slice(0, 360));
}

function ThreadCard({ id, forks }: { id: string; forks: number }) {
  const t = useThreads((s) => s.threads[id]);
  const state = useThreadState(id);
  const elsewhere = useRunsElsewhere(id);
  const background = useBackgroundOnly(id);
  const owner = useThreads((s) => s.owner[id] ?? "codex");
  if (!t) return null;

  // An unnamed thread's title is just its first message, so the message alone leads.
  const named = !!t.name?.trim();
  const preview = previewText(t.preview ?? "");
  const status = elsewhere ? `Running in another ${PROVIDERS[owner].name} app` : background && state === "running" ? backgroundLabel(background) : state === "idle" ? null : STATE_LABEL[state];
  const origin = originLabel(t.originator, t.source);
  const branch = t.gitInfo?.branch;
  const meta = [status, `Updated ${timeAgo(t.updatedAt) === "now" ? "just now" : `${timeAgo(t.updatedAt)} ago`}`, origin].filter(Boolean);

  return (
    <div className="hc-thread">
      {(named || !preview) && <div className="hc-title">{threadTitle(t)}</div>}
      {preview && <div className={`hc-preview ${named ? "" : "lead"}`}>{preview}</div>}
      <div className="hc-meta">
        <span className={`status-dot ${state} ${elsewhere ? "elsewhere" : ""}`} />
        <span className="hc-meta-text">{meta.join(" · ")}</span>
      </div>
      {(branch || t.model || forks > 0) && (
        <div className="hc-chips">
          {branch && (
            <span className="hc-chip">
              <GitBranch size={11} />
              <span className="hc-chip-text">{branch}</span>
            </span>
          )}
          {t.model && <span className="hc-chip">{t.model}</span>}
          {forks > 0 && (
            <span className="hc-chip">
              <GitFork size={11} />
              {forks} {forks === 1 ? "fork" : "forks"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Engine card (one per provider)
// ---------------------------------------------------------------------------

type Tone = "ok" | "info" | "warn" | "bad" | "muted";

/**
 * One status for a provider's badge and its card, most urgent first. Only Codex has a
 * Ret-managed copy, so `up` (its updater) is null for the others.
 */
export function engineStatus(codex: EngineStatus, up: UpdaterState | null): { label: string; tone: Tone; short: string | null } {
  if (codex.state === "disabled") return { label: "Off", tone: "muted", short: "off" };
  if (codex.state === "missing") return { label: "Not found", tone: "bad", short: "not found" };
  if (codex.state === "error") return { label: "Error", tone: "bad", short: "error" };
  if (codex.state === "starting") return { label: "Starting…", tone: "muted", short: null };
  if (codex.state === "stopped") return { label: "Stopped", tone: "warn", short: "stopped" };
  const u = up ? null : codex.update;
  if (u) {
    // A provider updated through its own updater (Claude Code), rather than Codex's managed copy.
    if (u.phase === "updating") return { label: "Updating…", tone: "info", short: "updating" };
    if (u.phase === "waiting") return { label: "Update waiting for idle", tone: "info", short: "update ready" };
    if (u.phase === "error") return { label: "Update failed", tone: "warn", short: "update failed" };
    if (u.latest && codex.version && isNewer(u.latest, codex.version)) return { label: "Update available", tone: "warn", short: "update available" };
    if (u.checkedAt) return { label: "Up to date", tone: "ok", short: null };
  }
  if (up?.phase === "downloading") {
    const pct = up.progress != null ? `${Math.round(up.progress * 100)}%` : "";
    return { label: `Downloading ${pct}`.trim(), tone: "info", short: pct || "updating" };
  }
  if (up?.phase === "verifying" || up?.phase === "extracting") return { label: "Installing…", tone: "info", short: "installing" };
  if (up?.staged) return { label: "Update ready", tone: "info", short: "update ready" };
  if (up?.latest && codex.version && isNewer(up.latest, codex.version)) return { label: "Update available", tone: "warn", short: "update available" };
  if (up?.lastCheckedAt) return { label: "Up to date", tone: "ok", short: null };
  return { label: "Running", tone: "ok", short: null };
}

/** a > b for versions like 0.130.0 and 0.131.0-alpha.2 (a pre-release sorts before its release). */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [main, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: main.split(".").map((n) => Number(n) || 0), pre: pre ?? null };
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d > 0;
  }
  if (x.pre === y.pre) return false;
  if (x.pre === null) return true;
  if (y.pre === null) return false;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true }) > 0;
}

const SOURCE: Record<string, string> = { managed: "Managed by Ret", system: "System install", custom: "Custom path" };

/** Home folder as ~, and the middle elided (past ~3 wrapped lines) so the file name always shows. */
function displayPath(p: string, max = 84): string {
  const home = p.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i, "~").replace(/^\/(?:Users|home)\/[^/]+/, "~");
  if (home.length <= max) return home;
  const sep = home.includes("\\") ? "\\" : "/";
  const parts = home.split(sep);
  const tail = parts.slice(-2).join(sep);
  let head = parts[0];
  for (const part of parts.slice(1, -2)) {
    if ((head + sep + part).length + tail.length + 3 > max) break;
    head += sep + part;
  }
  return `${head}${sep}…${sep}${tail}`;
}

function EngineCard({ provider }: { provider: ProviderId }) {
  const codex = useConn((s) => s.providers[provider].status);
  const updater = useConn((s) => s.updater);
  const up = provider === "codex" ? updater : null;
  if (!codex) return null;
  const st = engineStatus(codex, up);
  const local = !!codex.binaryPath && !/^wss?:/.test(codex.binaryPath);
  const rows: [string, ReactNode][] = [];
  if (codex.source) rows.push(["Source", SOURCE[codex.source] ?? codex.source]);
  if (provider === "codex") rows.push(["Engine", codex.engine === "shared" ? "Shared Codex daemon" : "Ret's own app-server"]);
  if (codex.binaryPath) rows.push([local ? "Location" : "Connection", <span className="mono hc-path">{displayPath(codex.binaryPath)}</span>]);
  if (up?.staged) rows.push(["Next", <span><span className="mono">{up.staged}</span> installs when Ret is idle</span>]);
  else if (st.label === "Update available") rows.push(["Latest", <span className="mono">{up!.latest}</span>]);
  if (up?.lastCheckedAt) rows.push(["Checked", timeAgo(up.lastCheckedAt / 1000) === "now" ? "just now" : `${timeAgo(up.lastCheckedAt / 1000)} ago`]);
  const own = up ? null : codex.update;
  if (own?.latest && st.label === "Update available") rows.push(["Latest", <span className="mono">{own.latest}</span>]);
  if (own?.checkedAt) rows.push(["Checked", timeAgo(own.checkedAt / 1000) === "now" ? "just now" : `${timeAgo(own.checkedAt / 1000)} ago`]);
  const error = codex.error ?? (up?.phase === "error" ? up.error : own?.phase === "error" ? own.error : null);

  return (
    <div className="hc-codex">
      <div className="hc-codex-head">
        <span className="hc-codex-name">{PROVIDERS[provider].name}</span>
        {codex.version && <span className="mono hc-version">{codex.version}</span>}
        <span className={`hc-pill ${st.tone}`}>{st.label}</span>
      </div>
      {up?.phase === "downloading" && up.progress != null && (
        <div className="hc-progress">
          <div style={{ width: `${Math.round(up.progress * 100)}%` }} />
        </div>
      )}
      <dl className="hc-rows">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {error && <div className="hc-error">{error}</div>}
      <div className="hc-hint">Click for {PROVIDERS[provider].name} settings</div>
    </div>
  );
}

import type { ThreadItem } from "@shared/protocol";

// What a working thread is up to, read off the latest item of its live turn, and the words for it:
// the Working row's verb (Ret's take on "Thinking…") and the Ret bot's mood beside it. The desktop
// and the phone both show them (components/thread/useWork).

/**
 * What the Ret bot's up to: thinking, working (any kind of busy: reading, running, editing,
 * writing…), dozing while work it left runs, or waiting on you. Each has a pool of loops
 * (lib/retBotMotion).
 */
export type BotMood = "think" | "work" | "doze" | "ask";

export type WorkKind = "think" | "plan" | "read" | "run" | "edit" | "web" | "tool" | "agents" | "wait" | "write" | "compact" | "work" | "ask";

/** `item`: the last item of the live turn (none yet: it just started). */
export function workKindOf(item: ThreadItem | undefined): WorkKind {
  if (!item) return "work";
  // A step that's over leaves the agent working out what's next.
  if ("status" in item && item.status !== "inProgress") return "work";
  switch (item.type) {
    case "reasoning":
      return "think";
    case "plan":
      return "plan";
    case "agentMessage":
      return "write";
    case "commandExecution": {
      const t = item.commandActions[0]?.type;
      return t === "read" || t === "search" || t === "listFiles" ? "read" : "run";
    }
    case "fileChange":
      return "edit";
    case "imageView":
      return "read";
    case "webSearch":
      return "web";
    case "mcpToolCall":
    case "dynamicToolCall":
    case "imageGeneration":
      return "tool";
    case "collabAgentToolCall":
    case "subAgentActivity":
      return "agents";
    case "sleep":
      return "wait";
    case "contextCompaction":
      return "compact";
    default:
      return "work";
  }
}

export const WORK_MOOD: Record<WorkKind, BotMood> = {
  think: "think",
  plan: "think",
  read: "work",
  run: "work",
  edit: "work",
  web: "work",
  tool: "work",
  agents: "work",
  wait: "doze",
  write: "work",
  compact: "work",
  work: "work",
  ask: "ask",
};

/** What it's doing, plainly, for the row's tooltip. */
export const WORK_LABEL: Record<WorkKind, string> = {
  think: "Thinking",
  plan: "Planning",
  read: "Reading",
  run: "Running a command",
  edit: "Editing files",
  web: "Searching the web",
  tool: "Using a tool",
  agents: "Working with its agents",
  wait: "Waiting",
  write: "Writing",
  compact: "Compacting the conversation",
  work: "Working",
  ask: "Needs your input",
};

const VERBS: Record<WorkKind, readonly string[]> = {
  think: [
    "Antenna-twiddling",
    "Head-scratching",
    "Rubber-ducking",
    "Woolgathering",
    "Brain-whirring",
    "Mulling it over",
    "Hmm-ing and haw-ing",
    "Untangling a thought",
    "Connecting the dots",
    "Galaxy-braining",
    "Chewing on it",
    "Daydreaming in diffs",
    "Overthinking it a little",
  ],
  plan: ["Scheming", "Plotting", "Drawing up plans", "Mapping it out", "Blueprinting", "Plotting a course"],
  read: [
    "Rummaging",
    "Sniffing around",
    "Leafing through",
    "Poking around",
    "Nosing about",
    "Grepping about",
    "Peeking under the hood",
    "Squinting at code",
    "Code-sleuthing",
    "Turning over rocks",
  ],
  run: [
    "Shelling out",
    "Lever-pulling",
    "Crank-turning",
    "Kicking the tires",
    "Jiggling the handle",
    "Clickety-clacking",
    "Bzzt-ing",
    "Whirring away",
    "Revving it up",
    "Rattling the pipes",
  ],
  edit: [
    "Tinkering",
    "Whittling",
    "Soldering",
    "Darning",
    "Bit-twiddling",
    "Bracket-balancing",
    "Lint-picking",
    "Semicolon-sprinkling",
    "Snipping and tucking",
    "Tightening bolts",
    "Sanding the edges",
  ],
  web: ["Rabbit-holing", "Link-hopping", "Tab-hoarding", "Web-wandering", "Net-casting", "Surfing the tubes"],
  tool: ["Gizmo-fiddling", "Doohickey-wrangling", "Thingamajigging", "Wrench-wiggling", "Plugging things in", "Gadgeteering"],
  agents: ["Herding bots", "Rallying the troops", "Calling in backup", "Divvying it up", "Wrangling helpers", "Huddling up"],
  wait: ["Twiddling thumbs", "Biding its time", "Counting sheep", "Resting its antennae", "Snoozing"],
  write: ["Scribbling", "Wordsmithing", "Typing it up", "Spinning a yarn", "Jotting it down", "Waxing lyrical"],
  compact: ["Folding the thread", "Packing light", "Squishing the context", "Spring-cleaning", "Tidying its memory"],
  work: [
    "Flibberjabbing",
    "Beep-booping",
    "Bleep-blooping",
    "Retting",
    "Puttering",
    "Humming along",
    "Whirligigging",
    "Jibberflapping",
    "Wibble-wobbling",
    "Gubbins-fiddling",
    "Fiddle-faddling",
    "Zhuzhing",
    "Razzmatazzing",
    "Higgledy-piggledying",
    "Kerfuffling",
    "Thingamabobbing",
    "Unspooling",
  ],
  ask: ["Waiting on you", "Your move", "Psst, over here", "Tapping its foot", "All antennae"],
};

/**
 * The verb for a kind of work in a turn: the same in every view of the turn (and each time the
 * kind comes back), and a different one every 15 s of it.
 */
export function workVerb(kind: WorkKind, turnId: string, secs: number): string {
  const list = VERBS[kind];
  return list[(hash(turnId + kind) + Math.floor(secs / 15)) % list.length];
}

/** FNV-1a. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

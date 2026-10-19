import type { ProviderId } from "@shared/bridge";
import type { Model, RateLimitSnapshot, RateLimitWindow } from "@shared/protocol/generated/v2";
import { blankThread, freshUsage, type DemoThread, type ThreadConf, type World } from "./engine";
import { buildTurns, type TurnSpec } from "./history";
import type { Turn, UsageActivity } from "@shared/protocol";
import { userMessage } from "./items";
import { notesElsewhere, ORDERS_QUESTION, ordersQuestion, passkeysRetry, rateApproval, respond, viteLive } from "./scripts";
import * as W from "./workspace";
import { localDay } from "../lib/format";

/**
 * The demo's threads. Ids are fixed so the seeded layout (seed.ts) can place them; times are
 * relative to when the page opened.
 */
export const T = {
  // Codex
  rate: "019e1a2b-7c3d-7e4f-8a5b-6c7d8e9f0a1b",
  redis: "019e1a3c-1d2e-7f30-9b41-5c6d7e8f9a0b",
  vite: "019e1a5d-4e5f-7061-8c72-3d4e5f6a7b8c",
  notes: "019e1a4e-2f30-7142-9d53-4e5f60718293",
  healthz: "019e0f12-3a4b-7c5d-8e6f-7a8b9c0d1e2f",
  // Claude Code
  orders: "3f6b2c1d-8e4a-4b7c-9d2e-1a5f6c7b8d9e",
  passkeys: "8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  node22: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
  flaky: "d4e5f6a7-b8c9-4d0e-8f1a-2b3c4d5e6f70",
  docsPreview: "e5f6a7b8-c9d0-4e1f-9a2b-3c4d5e6f7a81",
} as const;

const MIN = 60;
const HOUR = 3600;
const DAY = 86_400;

// ---------------------------------------------------------------------------
// Models, limits
// ---------------------------------------------------------------------------

const EFFORT_TEXT: Record<string, string> = {
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth",
  max: "Maximum reasoning depth for the hardest problems",
};

function model(id: string, displayName: string, description: string, efforts: string[], defaultEffort: string, opts: { tiers?: Model["serviceTiers"]; isDefault?: boolean } = {}): Model {
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName,
    description,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e as never, description: EFFORT_TEXT[e] ?? e })),
    defaultReasoningEffort: defaultEffort as never,
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: opts.tiers ?? [],
    defaultServiceTier: null,
    availableAccessPrograms: null,
    isDefault: !!opts.isDefault,
  };
}

const ALL = ["low", "medium", "high", "xhigh", "max"];
const FAST = [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }];
const CLAUDE_FAST = [{ id: "priority", name: "Fast", description: "Faster output, at a higher cost" }];

const MODELS: Record<ProviderId, Model[]> = {
  codex: [
    model("gpt-6.1-sol", "GPT-6.1-Sol", "Latest workhorse model for coding and everyday work.", ALL, "medium", { tiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }], isDefault: true }),
    model("gpt-6-astra", "GPT-6-Astra", "Frontier intelligence for the most demanding work.", ALL, "medium", { tiers: FAST }),
    model("gpt-6-luna", "GPT-6-Luna", "Fast and affordable model for easier tasks.", ALL, "medium", { tiers: FAST }),
  ],
  claude: [
    model("default", "Default (Opus 5.5)", "Opus 5.5 · Most capable for complex work", ALL, "high", { tiers: CLAUDE_FAST, isDefault: true }),
    model("opus", "Opus 5.5", "Most capable for complex work", ALL, "high", { tiers: CLAUDE_FAST }),
    model("sonnet", "Sonnet 5.5", "Best for everyday tasks", ALL, "high"),
    model("haiku", "Haiku 5.5", "Fastest for quick answers", ["low", "medium", "high"], "medium"),
  ],
  // The demo's ACP agents are off.
  opencode: [],
  acp: [],
};

function snapshot(id: string, name: string | null, primary: RateLimitWindow | null, secondary: RateLimitWindow | null, planType: RateLimitSnapshot["planType"] = null): RateLimitSnapshot {
  return { limitId: id, limitName: name, normalModelSlug: null, primary, secondary, credits: null, individualLimit: null, spendControlReached: null, planType, rateLimitReachedType: null };
}

function limits(now: number) {
  const w = (usedPercent: number, mins: number, resetsIn: number): RateLimitWindow => ({ usedPercent, windowDurationMins: mins, resetsAt: Math.floor(now + resetsIn) });
  return {
    codex: { snapshot: snapshot("codex", null, w(31, 300, 2 * HOUR + 14 * MIN), w(58, 10_080, 3 * DAY + 5 * HOUR), "pro"), byId: {} },
    claude: {
      snapshot: snapshot("claude", null, w(22, 300, 3 * HOUR + 41 * MIN), w(47, 10_080, 4 * DAY + 2 * HOUR)),
      byId: { seven_day_opus: snapshot("seven_day_opus", "Opus", w(64, 10_080, 4 * DAY + 2 * HOUR), null) },
    },
    opencode: { snapshot: snapshot("opencode", null, null, null), byId: {} },
    acp: { snapshot: snapshot("acp", null, null, null), byId: {} },
  };
}

/** How prompts spread over the day: quiet overnight, building through the afternoon, busiest in the evening. */
const HOUR_WEIGHTS = [3, 2, 1, 0, 0, 0, 0, 1, 3, 5, 7, 8, 6, 7, 8, 8, 7, 6, 6, 8, 10, 11, 9, 5];

/**
 * A year of what each day held: use picking up over the months, busy weekdays and quieter
 * weekends, the odd day off and two weeks away, newer models taking over. Same every visit.
 */
function usageHistory(now: number) {
  let seed = 20_261_013;
  const rand = () => (seed = (seed * 48_271) % 2_147_483_647) / 2_147_483_647;
  const hourTotal = HOUR_WEIGHTS.reduce((a, b) => a + b, 0);
  const hour = () => {
    let r = rand() * hourTotal;
    return HOUR_WEIGHTS.findIndex((w) => (r -= w) < 0);
  };
  // The model mix by days ago: what was current then.
  const mix = (p: ProviderId, ago: number): [string, number][] =>
    p === "codex"
      ? [[ago > 110 ? "gpt-6-sol" : "gpt-6.1-sol", 0.64], ["gpt-6-astra", 0.24], ["gpt-6-luna", 0.12]]
      : [[ago > 150 ? "claude-opus-5" : "claude-opus-5-5", 0.7], ["claude-sonnet-5-5", 0.2], ["claude-haiku-5-5", 0.1]];
  const out: Record<ProviderId, UsageActivity> = { codex: { days: {} }, claude: { days: {} }, opencode: { days: {} }, acp: { days: {} } };
  for (let ago = 370; ago >= 0; ago--) {
    const day = new Date((now - ago * DAY) * 1000);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    const away = (ago >= 196 && ago < 210) || ago === 41;
    const ramp = Math.min(1, 0.12 + (370 - ago) / 290);
    for (const [p, scale] of [["codex", 140e6], ["claude", 90e6]] as const) {
      const r = rand();
      if (away || r < (weekend ? 0.45 : 0.06) + (1 - ramp) * 0.45) continue;
      const tokens = Math.round(scale * ramp * (weekend ? 0.3 : 1) * (0.35 + r));
      const models: Record<string, number> = {};
      for (const [m, share] of mix(p, ago)) models[m] = Math.round(tokens * share * (0.7 + rand() * 0.6));
      const prompts = Math.max(1, Math.round((tokens / scale) * 34 * (0.6 + rand() * 0.8)));
      const hours = new Array<number>(24).fill(0);
      for (let i = 0; i < prompts; i++) hours[hour()]++;
      out[p].days[localDay(day)] = { tokens: Object.values(models).reduce((a, b) => a + b, 0), models, prompts, hours };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

interface Def {
  provider: ProviderId;
  id: string;
  cwd: string;
  name: string;
  created: number;
  model: string | null;
  conf?: Partial<ThreadConf>;
  /** Context in use (tokens) as of the last turn. */
  context: number;
  forkedFrom?: string;
  failed?: boolean;
  turns: TurnSpec[];
}

/** What a search printed, from the files as they are at load. */
function grep(world: World, root: string, query: string, dir: string | null): string {
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const out: string[] = [];
  for (const f of world.fs.walk(dir ? `${root}/${dir}` : root)) {
    if (f.includes("/node_modules/")) continue;
    (world.fs.read(f) ?? "").split("\n").forEach((line, i) => {
      if (re.test(line)) out.push(`${f.slice(root.length + 1)}:${i + 1}:${line.trim()}`);
    });
  }
  return out.join("\n");
}

const vitestOut = (cwd: string, file: string, n: number, at: string) =>
  `\n RUN  v3.2.4 ${cwd}\n\n ✓ ${file} (${n} tests) ${n * 2}ms\n\n Test Files  1 passed (1)\n      Tests  ${n} passed (${n})\n   Start at  ${at}\n   Duration  412ms (transform 61ms, setup 0ms, collect 58ms, tests ${n * 2}ms, environment 0ms, prepare 102ms)\n`;

const hhmmss = (sec: number) => new Date(sec * 1000).toTimeString().slice(0, 8);

const RATE_TURN_1 = (at: number): TurnSpec => ({
  at,
  took: 3 * MIN + 12,
  build: (b) =>
    b
      .user("Add rate limiting to /login and keep the tests green.")
      .think("**Reading the sign-in flow**\n\nBefore picking a limiter I want to see how `/login` is wired, whether anything already throttles it, and what the tests cover.")
      .search(
        "login",
        "src test",
        [
          'src/server/routes.ts:3:import { login, logout, me } from "./auth.js";',
          'src/server/routes.ts:9:  r.post("/login", login(db));',
          "src/server/auth.ts:13:export const login = (db: Db): RequestHandler => async (req, res) => {",
          'test/auth.test.ts:6:describe("POST /login", () => {',
          'test/auth.test.ts:15:    const res = await request(app).post("/login").send({ email: "ada@example.com", password: "correct horse" });',
          'test/auth.test.ts:21:    const res = await request(app).post("/login").send({ email: "ada@example.com", password: "nope" });',
          'test/auth.test.ts:26:    const res = await request(app).post("/login").send({ email: "not-an-email" });',
        ].join("\n"),
      )
      .read("src/server/auth.ts", W.API_AUTH_BEFORE)
      .read("test/auth.test.ts", W.API_AUTH_TEST_BEFORE)
      .search("limit", "src", 'src/server/app.ts:9:  app.use(express.json({ limit: "100kb" }));')
      .think("**Choosing a limiter**\n\nA token bucket keyed by IP + email covers one client guessing many passwords and one account being hammered from one client. In memory is fine while the API runs as a single instance.")
      .say(
        `Nothing throttles \`/login\` today: it validates the body and goes straight to \`argon2.verify\`, so a script can guess passwords as fast as argon2 allows.

Here's what I'd add:

- **A token bucket per IP + email**: 5 attempts per 15 minutes, refilling continuously. Keying on both means one client can't lock everyone out of an account, and one account can't be guessed at without limit from one client.
- **\`429 Too Many Requests\` with \`Retry-After\`** once the bucket is empty.
- **A successful sign-in resets the bucket**, so a typo or two never locks anyone out.
- **In memory for now.** With several API instances behind the load balancer, the counts would have to live in Redis.

The tests cover the happy path, a wrong password and a malformed body. I'd add cases for the limit, the reset, and limits being per email. Want me to go ahead?`,
      ),
});

function defs(world: World, now: number): Def[] {
  return [
    // ---- api ---------------------------------------------------------------
    {
      provider: "codex",
      id: T.rate,
      cwd: W.P.api,
      name: "Rate-limit the login endpoint",
      created: now - 38 * MIN,
      model: "gpt-6.1-sol",
      conf: { effort: "high" },
      context: 61_400,
      turns: [
        RATE_TURN_1(now - 38 * MIN),
        {
          at: now - 4 * MIN - 40,
          took: null,
          plan: [
            ["Add a token-bucket limiter", "completed"],
            ["Wire it into POST /login with Retry-After", "completed"],
            ["Test the limit, the reset and per-email keys", "inProgress"],
          ],
          build: (b) =>
            b
              .user("Go ahead. In memory for now, and add tests.")
              .think("**Writing the limiter**\n\nKeeping the bucket math in a small class with an injectable clock, so the tests don't need fake timers.")
              .change({ rel: "src/server/rateLimit.ts", before: null, after: W.API_RATE_LIMIT })
              .change({ rel: "src/server/auth.ts", before: W.API_AUTH_BEFORE, after: W.API_AUTH_AFTER })
              .change({ rel: "test/rateLimit.test.ts", before: null, after: W.API_RATE_LIMIT_TEST }, { rel: "test/auth.test.ts", before: W.API_AUTH_TEST_BEFORE, after: W.API_AUTH_TEST_AFTER })
              .run("npx vitest run test/rateLimit.test.ts", vitestOut(W.P.api, "test/rateLimit.test.ts", 4, hhmmss(now - 90)), { ms: 1840 })
              .say("The limiter's unit tests pass. The auth tests run against the local Postgres, which the sandbox can't reach, so I'll ask before running them.", "commentary"),
        },
      ],
    },
    {
      provider: "codex",
      id: T.redis,
      cwd: W.REDIS_WT.path,
      name: "Try a Redis store",
      created: now - 32 * MIN,
      model: "gpt-6.1-sol",
      conf: { effort: "high" },
      context: 74_900,
      forkedFrom: T.rate,
      turns: [
        RATE_TURN_1(now - 38 * MIN),
        {
          at: now - 31 * MIN,
          took: 4 * MIN + 41,
          build: (b) =>
            b
              .user("Same idea, but back it with Redis so the limit holds across instances.")
              .think("**Picking a Redis structure**\n\nA sorted set per key, holding attempt timestamps, gives a true sliding window: trim what's older than 15 minutes, count what's left. One MULTI keeps each check to a single round trip.")
              .read("docker-compose.yml", world.fs.read(`${W.P.api}/docker-compose.yml`) ?? "")
              .read("package.json", W.API_PACKAGE_BASE)
              .change({ rel: "src/server/store/redis.ts", before: null, after: W.API_REDIS_STORE })
              .change({ rel: "src/server/rateLimit.ts", before: null, after: W.API_RATE_LIMIT_REDIS })
              .change({ rel: "src/server/auth.ts", before: W.API_AUTH_BEFORE, after: W.API_AUTH_REDIS }, { rel: "package.json", before: W.API_PACKAGE_BASE, after: W.API_PACKAGE_REDIS })
              .run("npm install", "\nadded 9 packages, and audited 214 packages in 2s\n\n41 packages are looking for funding\n  run `npm fund` for details\n\nfound 0 vulnerabilities\n", { ms: 2400 })
              .run("docker compose up -d redis", "[+] Running 2/2\n ✔ Network api_default      Created\n ✔ Container api-redis-1    Started\n", { ms: 1900 })
              .run("npx tsc --noEmit", "", { ms: 3100 })
              .run("npm test -- auth", `\n> api@2.4.0 test\n> vitest run auth\n${vitestOut(W.REDIS_WT.path, "test/auth.test.ts", 3, hhmmss(now - 27 * MIN))}`, { ms: 2700 })
              .say(
                `Here's the Redis version, in its own worktree (\`${W.REDIS_WT.branch}\`) so it doesn't touch the in-memory one.

- **\`src/server/store/redis.ts\`**: one \`ioredis\` connection per process, failing fast instead of queueing when Redis is down.
- **\`src/server/rateLimit.ts\`**: a sliding window per IP + email in a sorted set. Each check is one \`MULTI\`: trim attempts older than 15 minutes, count the rest, read the oldest for \`Retry-After\`.
- **\`src/server/auth.ts\`**: same \`429\` + \`Retry-After\` behavior, now \`await\`ing the limiter.

| | In memory | Redis |
| --- | --- | --- |
| Shared across instances | No | Yes |
| Survives a deploy | No | Yes |
| Cost per sign-in | ~0 | one round trip (~0.3 ms locally) |
| If Redis is down | n/a | sign-in errors until it's back |

Typecheck and the auth tests pass. If you'd rather let sign-ins through while Redis is unreachable, I can catch that in \`check()\`.`,
              ),
        },
      ],
    },
    {
      provider: "claude",
      id: T.node22,
      cwd: W.P.api,
      name: "Bump Node to 22 in CI",
      created: now - 2 * DAY - 5 * HOUR,
      model: "claude-sonnet-5-5",
      conf: { model: "sonnet" },
      context: 31_200,
      turns: [
        {
          at: now - 2 * DAY - 5 * HOUR,
          took: 2 * MIN + 18,
          build: (b) =>
            b
              .user("CI is still on Node 20. Move it to 22 and make sure nothing breaks.")
              .read(".github/workflows/ci.yml", W.API_CI_BEFORE)
              .read("package.json", W.API_PACKAGE_BASE)
              .change({ rel: ".github/workflows/ci.yml", before: W.API_CI_BEFORE, after: W.API_CI_AFTER })
              .change({ rel: ".nvmrc", before: null, after: "22\n" })
              .run(
                "nvm use 22 && npm ci && npm test",
                `Now using node v22.20.0 (npm v10.9.3)\n\nadded 212 packages, and audited 213 packages in 4s\n\nfound 0 vulnerabilities\n\n> api@2.4.0 test\n> vitest run\n${vitestOut(W.P.api, "test/auth.test.ts", 3, hhmmss(now - 2 * DAY - 5 * HOUR + 100))}`,
                { ms: 21_400 },
              )
              .say(
                "CI runs on Node 22 now:\n\n- `.github/workflows/ci.yml`: `node-version: 22`\n- Added `.nvmrc` with `22`, so `nvm use` picks the same version locally\n\nA clean `npm ci` and the full test suite pass on 22.20. Nothing depended on Node 20: `argon2` ships prebuilt binaries for 22, and nothing here uses the APIs 22 removed.",
              ),
        },
      ],
    },

    // ---- web ---------------------------------------------------------------
    {
      provider: "codex",
      id: T.vite,
      cwd: W.P.web,
      name: "Move us off webpack",
      created: now - 6 * MIN - 12,
      model: "gpt-6.1-sol",
      conf: { effort: "medium" },
      context: 38_700,
      turns: [
        {
          at: now - 6 * MIN - 10,
          took: null,
          plan: [
            ["Port the config to vite.config.ts", "completed"],
            ["Swap scripts and dependencies", "inProgress"],
            ["Move index.html to the project root", "pending"],
            ["Verify the build, dev server and HMR", "pending"],
          ],
          build: (b) =>
            b
              .user("Move us off webpack. Vite 8, keep the dev server on :3000, and don't change the CSS module class names (the e2e tests select on them).")
              .think("**Mapping the webpack setup**\n\nChecking what the config actually does, so the Vite version carries over behavior rather than options.")
              .search("webpack", null, grep(world, W.P.web, "webpack", null))
              .read("webpack.config.js", W.WEB_WEBPACK)
              .read("package.json", W.WEB_PACKAGE_BEFORE)
              .read("public/index.html", W.WEB_INDEX_PUBLIC)
              .say(
                "Everything webpack does here, Vite does out of the box: TypeScript, CSS modules, assets. What needs carrying over is the `@/` alias, the `/api` proxy to `:4000`, port `3000`, and the CSS module naming, since the e2e tests select on those class names.",
                "commentary",
              )
              .change({ rel: "vite.config.ts", before: null, after: W.WEB_VITE }),
        },
      ],
    },
    {
      provider: "claude",
      id: T.flaky,
      cwd: W.P.web,
      name: "Fix flaky checkout e2e test",
      created: now - DAY - 3 * HOUR,
      model: "claude-opus-5-5",
      context: 44_800,
      turns: [
        {
          at: now - DAY - 3 * HOUR,
          took: 3 * MIN + 9,
          build: (b) =>
            b
              .user("The checkout e2e test fails about one run in ten on CI. Can you find out why?")
              .think("A one-in-ten failure in an e2e test usually means a timing assumption somewhere. Let me look at the test and the component it drives.")
              .read("e2e/checkout.spec.ts", W.WEB_E2E_BEFORE)
              .read("src/routes/Checkout.tsx", world.fs.read(`${W.P.web}/src/routes/Checkout.tsx`) ?? "")
              .run(
                "npx playwright test checkout --repeat-each 30 --workers 4",
                "\nRunning 30 tests using 4 workers\n\n  ✘  12 [chromium] › e2e/checkout.spec.ts:3:5 › places an order (repeat12) (1.6s)\n  ✘  19 [chromium] › e2e/checkout.spec.ts:3:5 › places an order (repeat19) (1.5s)\n  ✘  27 [chromium] › e2e/checkout.spec.ts:3:5 › places an order (repeat27) (1.7s)\n\n    Error: expect(received).toBe(expected)\n\n    Expected: \"Place order\"\n    Received: \"Placing…\"\n\n  3 failed\n  27 passed (19.8s)\n",
                { exit: 1, ms: 21_800 },
              )
              .say(
                "Reproduced it: 3 of 30 runs fail. The test clicks **Place order**, waits a fixed 500 ms, and expects the button to read “Place order” again. When the request takes longer than that, it still says “Placing…”.",
              )
              .change({ rel: "e2e/checkout.spec.ts", before: W.WEB_E2E_BEFORE, after: W.WEB_E2E_AFTER })
              .run("npx playwright test checkout --repeat-each 30 --workers 4", "\nRunning 30 tests using 4 workers\n\n  30 passed (21.2s)\n", { ms: 23_100 })
              .say(
                "Fixed. Instead of sleeping 500 ms, the test now waits for the `POST /api/orders` response itself, then for the button to be enabled again. 30 runs in a row pass (3 of 30 failed before).\n\nThe component was fine; only the test assumed the request would always be quick.",
              ),
        },
      ],
    },

    // ---- shop --------------------------------------------------------------
    {
      provider: "claude",
      id: T.orders,
      cwd: W.P.shop,
      name: "Orders page does 300 queries",
      created: now - 9 * MIN,
      model: "claude-opus-5-5",
      context: 52_300,
      turns: [
        {
          at: now - 9 * MIN,
          took: null,
          plan: [
            ["Find where the orders page loads its data", "completed"],
            ["Measure the queries per request", "completed"],
            ["Fix the N+1 in listOrders", "pending"],
            ["Add a regression test for the query count", "pending"],
          ],
          build: (b) => {
            b.user("Orders page does 300 queries. Fix it.")
              .think("The admin orders page is slow, and 300 queries smells like an N+1 in the repo layer. Let me find where the list is built.")
              .search("listOrders", "src", grep(world, W.P.shop, "listOrders", "src"))
              .read("src/orders/repo.ts", W.SHOP_REPO_BEFORE)
              .read("src/orders/types.ts", world.fs.read(`${W.P.shop}/src/orders/types.ts`) ?? "")
              .run("npm run query-log -- /admin/orders", "\n> shop@1.12.0 query-log\n> tsx scripts/query-log.ts /admin/orders\n\nGET /admin/orders: 301 queries, 1184 ms in SQL, 1342 ms total\n", { ms: 4300 })
              .say(
                "Found it. `listOrders` loads a page of 100 orders, then runs three more queries **for each order** (its items, its customer, its shipping address): 1 + 3 × 100 = **301 queries**, about 1.3 s per page.\n\nThere are a few ways to fix it with different trade-offs, so let me check which you'd prefer.",
              );
            ordersAsked = b.asked(ORDERS_QUESTION, null);
          },
        },
      ],
    },
    {
      provider: "codex",
      id: T.healthz,
      cwd: W.P.shop,
      name: "Add a /healthz endpoint",
      created: now - 3 * DAY - 2 * HOUR,
      model: "gpt-6-luna",
      conf: { model: "gpt-6-luna", effort: "medium" },
      context: 18_900,
      turns: [
        {
          at: now - 3 * DAY - 2 * HOUR,
          took: MIN + 52,
          build: (b) =>
            b
              .user("Add a /healthz endpoint for the load balancer. It should fail if the database is down.")
              .think("**Finding the app setup**\n\nThe endpoint belongs next to the other routes in `src/server.ts`, outside any admin auth.")
              .read("src/server.ts", W.SHOP_SERVER_BEFORE)
              .read("src/db/index.ts", world.fs.read(`${W.P.shop}/src/db/index.ts`) ?? "")
              .change({ rel: "src/server.ts", before: W.SHOP_SERVER_BEFORE, after: W.SHOP_SERVER_AFTER })
              .run("npx tsc --noEmit", "", { ms: 2600 })
              .run('curl -s -w "\\n%{http_code}\\n" localhost:4100/healthz', '{"ok":true}\n200\n', { ms: 120 })
              .say(
                "Added `GET /healthz` in `src/server.ts`, before the admin routes:\n\n- `200 {\"ok\":true}` when `select 1` succeeds\n- `503 {\"ok\":false}` when the database doesn't answer\n\nChecked it against the running server. At the load balancer's default 10 s interval that's one tiny query per probe.",
              ),
        },
      ],
    },

    // ---- docs --------------------------------------------------------------
    {
      provider: "codex",
      id: T.notes,
      cwd: W.P.docs,
      name: "Draft release notes",
      created: now - 17 * MIN,
      model: "gpt-6.1-sol",
      conf: { effort: "medium" },
      context: 27_600,
      turns: [
        {
          at: now - 17 * MIN,
          took: 2 * MIN + 41,
          build: (b) =>
            b
              .user("Draft release notes for 2.4 from the PRs merged since v2.3.0. Group them by area and keep it short.")
              .think("**Collecting what shipped**\n\nListing the merges since the tag, then pulling titles from GitHub so the notes say what changed rather than branch names.")
              .run(
                "git log v2.3.0..HEAD --merges --oneline",
                [
                  "a41c9e2 Merge pull request #408 from acme/keep-cart-on-sign-in",
                  "77d01b3 Merge pull request #406 from acme/partial-refunds",
                  "c3f9a10 Merge pull request #404 from acme/webhook-signature-v2",
                  "19be6d4 Merge pull request #403 from acme/session-ttl",
                  "5e2d7af Merge pull request #402 from acme/csv-shipping-address",
                  "8f61c25 Merge pull request #401 from acme/avif-images",
                  "0d4b8e9 Merge pull request #400 from acme/eslint-9",
                  "b7a2f31 Merge pull request #399 from acme/double-order-race",
                  "e98c40d Merge pull request #397 from acme/me-deleted-user",
                  "2c7e5b6 Merge pull request #396 from acme/order-totals-refactor",
                  "f1d3a77 Merge pull request #395 from acme/search-order-hash",
                  "6a90cc1 Merge pull request #393 from acme/express-5",
                ].join("\n") + "\n",
                { ms: 180 },
              )
              .run(
                "gh pr list --state merged --base main --limit 12 --json number,title --jq '.[] | \"#\\(.number) \\(.title)\"'",
                [
                  "#408 Keep the cart when signing in during checkout",
                  "#406 Partial refunds per line item",
                  "#404 Sign webhook payloads with HMAC-SHA256 (v2)",
                  "#403 Shorten session lifetime to 7 days",
                  "#402 CSV export: include shipping address",
                  "#401 Serve product images as AVIF when supported",
                  "#400 Bump eslint to 9",
                  "#399 Prevent double orders from two tabs",
                  "#397 GET /me: 401 instead of 500 for deleted users",
                  "#396 Refactor order totals",
                  "#395 Search: match order numbers with or without #",
                  "#393 Express 5, Node 22 in CI",
                ].join("\n") + "\n",
                { ms: 1450 },
              )
              .read("CHANGELOG.md", world.fs.read(`${W.P.docs}/CHANGELOG.md`) ?? "")
              .read("docs/releases/2.3.md", world.fs.read(`${W.P.docs}/docs/releases/2.3.md`) ?? "")
              .change(
                { rel: "docs/releases/2.4.md", before: null, after: W.DOCS_RELEASE_24 },
                { rel: "docs/index.md", before: (world.fs.read(`${W.P.docs}/docs/index.md`) ?? "").replace("[2.4](./releases/2.4.md) · ", ""), after: world.fs.read(`${W.P.docs}/docs/index.md`) },
              )
              .say(
                `Here's the draft, grouped by area. It's in \`docs/releases/2.4.md\` and linked from the docs index.

- **Checkout**: cart kept across sign-in, AVIF images
- **Back office**: partial refunds, shipping address in the CSV export, order-number search
- **Security**: v2 webhook signatures, 7-day sessions
- **Fixes**: duplicate orders from two tabs, \`GET /me\` for deleted users
- **Under the hood**: Express 5, Node 22 in CI

Two things to check before it goes out:

1. #404 says v1 signatures keep going "until 2.6", but there's no issue tracking their removal yet.
2. I left out #400 (eslint 9) and #396 (order totals refactor): no visible change for users.`,
              ),
        },
      ],
    },
    {
      provider: "claude",
      id: T.docsPreview,
      cwd: W.P.docs,
      name: "How do I preview the docs locally?",
      created: now - 5 * DAY - 4 * HOUR,
      model: "claude-haiku-5-5",
      conf: { model: "haiku" },
      context: 12_400,
      turns: [
        {
          at: now - 5 * DAY - 4 * HOUR,
          took: 41,
          build: (b) =>
            b
              .user("How do I preview the docs locally, and where does a new page go?")
              .read("package.json", world.fs.read(`${W.P.docs}/package.json`) ?? "")
              .read(".vitepress/config.ts", world.fs.read(`${W.P.docs}/.vitepress/config.ts`) ?? "")
              .list("docs", "getting-started.md\nguides\nindex.md\nreleases\n")
              .say(
                "Run `npm run dev` in this folder: VitePress serves the site at http://localhost:5173 with hot reload.\n\nA new page is a Markdown file under `docs/` (its URL follows the path, so `docs/guides/webhooks.md` becomes `/guides/webhooks`). Link it from `docs/index.md`, and add it to `themeConfig.nav` in `.vitepress/config.ts` if it should be in the top bar.",
              ),
        },
      ],
    },

    // ---- auth --------------------------------------------------------------
    {
      provider: "claude",
      id: T.passkeys,
      cwd: W.P.auth,
      name: "Add passkeys",
      created: now - 52 * MIN,
      model: "claude-opus-5-5",
      conf: { access: "acceptEdits" },
      context: 88_100,
      failed: true,
      turns: [
        {
          at: now - 52 * MIN,
          took: 5 * MIN + 48,
          status: "failed",
          error: "Connection lost while streaming the response (ECONNRESET). Send a message to pick up where it left off.",
          plan: [
            ["Read the WebAuthn notes and current routes", "completed"],
            ["Registration and sign-in endpoints", "completed"],
            ["Tests for the new endpoints", "inProgress"],
            ["Make the tests pass", "pending"],
          ],
          build: (b) =>
            b
              .user("Add passkeys as a sign-in option next to passwords. Follow docs/webauthn.md.")
              .think("Let me read the WebAuthn notes first, then the current routes and store, so the new endpoints fit what's there.")
              .read("docs/webauthn.md", world.fs.read(`${W.P.auth}/docs/webauthn.md`) ?? "")
              .read("src/routes.ts", W.AUTH_ROUTES_BEFORE)
              .read("src/store.ts", world.fs.read(`${W.P.auth}/src/store.ts`) ?? "")
              .change({ rel: "src/passkeys.ts", before: null, after: W.AUTH_PASSKEYS })
              .change({ rel: "src/routes.ts", before: W.AUTH_ROUTES_BEFORE, after: W.AUTH_ROUTES_AFTER })
              .change({ rel: "test/passkeys.test.ts", before: null, after: W.AUTH_PASSKEYS_TEST })
              .run(
                "npm test",
                "\n> auth@0.9.0 test\n> vitest run\n\n FAIL  test/passkeys.test.ts > passkeys > offers registration options for a signed-in user\nTypeError: Cannot read properties of undefined (reading 'getRandomValues')\n ❯ generateChallenge node_modules/@simplewebauthn/server/esm/helpers/generateChallenge.js:12:21\n ❯ generateRegistrationOptions node_modules/@simplewebauthn/server/esm/registration/generateRegistrationOptions.js:88:31\n ❯ startRegistration src/passkeys.ts:17:25\n\n FAIL  test/passkeys.test.ts > passkeys > offers sign-in options without a user\nTypeError: Cannot read properties of undefined (reading 'getRandomValues')\n ❯ startSignIn src/passkeys.ts:40:25\n\n Test Files  1 failed (1)\n      Tests  2 failed (2)\n",
                { exit: 1, ms: 2900 },
              )
              .say(
                "Both tests fail before reaching our code: jsdom has no WebCrypto, and `@simplewebauthn/server` needs `crypto.subtle` to make challenges. The fix is a small setup file that installs Node's `webcrypto` for the test environment. Adding it now.",
              ),
        },
      ],
    },
  ];
}

/** Id of the AskUserQuestion step the orders thread is waiting on (set while building it). */
let ordersAsked = "";

/** Fill the world: files, threads, models, limits, and the runs that start when engines connect. */
export function populate(world: World) {
  const now = Math.floor(Date.now() / 1000);
  W.seedFiles(world.fs);
  world.models = MODELS;
  world.defaults = { codex: { model: "gpt-6.1-sol", effort: "medium" }, claude: { model: "default", effort: "high" }, opencode: { model: "", effort: "" }, acp: { model: "", effort: "" } };
  world.limits = limits(now);
  world.usage = usageHistory(now);
  world.respond = respond;

  for (const d of defs(world, now)) {
    const { turns, plans } = buildTurns(d.provider, d.id, d.cwd, d.turns);
    const meta = blankThread(d.provider, d.id, d.cwd, d.created, d.model);
    const last = turns.at(-1)!;
    const updated = last.completedAt ?? now - 40;
    Object.assign(meta, {
      name: d.name,
      preview: (turns[0].items[0] as { content: { text?: string }[] }).content[0]?.text ?? d.name,
      updatedAt: updated,
      recencyAt: updated,
      forkedFromId: d.forkedFrom ?? null,
      reasoningEffort: d.conf?.effort ?? null,
    });
    const window = d.provider === "codex" ? 272_000 : 200_000;
    const usage = freshUsage(window, d.context);
    usage.total = { ...usage.total, totalTokens: d.context * (turns.length + 2), inputTokens: d.context * (turns.length + 1), outputTokens: Math.floor(d.context / 6) };
    const t: DemoThread = {
      provider: d.provider,
      meta,
      turns,
      plans,
      conf: { model: null, effort: null, plan: false, access: "config", serviceTier: null, ...d.conf },
      usage,
      failed: !!d.failed,
      run: null,
      subscribed: false,
      away: false,
      next: d.id === T.passkeys ? passkeysRetry : null,
    };
    world.threads.set(d.id, t);
  }

  const get = (id: string) => world.threads.get(id)!;
  // Once each engine connects: the running turn picks up, the approval and question are asked.
  world.boot.codex = () => {
    const rate = get(T.rate);
    world.launch(rate, rate.turns.at(-1)!, rateApproval);
    const vite = get(T.vite);
    world.launch(vite, vite.turns.at(-1)!, viteLive);
    // Half a minute in, the release notes pick up in the Codex CLI: Ret shows it running elsewhere.
    setTimeout(() => {
      const notes = get(T.notes);
      if (!notes || notes.run || notes.turns.length > 1) return;
      notes.away = true;
      const at = Math.floor(Date.now() / 1000);
      const turn: Turn = {
        id: `${T.notes.slice(0, 8)}-t2`,
        rootTurnId: null,
        items: [userMessage(`${T.notes.slice(0, 8)}-t2-i1`, "Add a line for self-hosters: the API needs Node 22 now.")],
        itemsView: "full",
        status: "inProgress",
        error: null,
        startedAt: at,
        completedAt: null,
        durationMs: null,
      };
      notes.turns.push(turn);
      notes.meta.updatedAt = at;
      notes.meta.recencyAt = at;
      world.launch(notes, turn, notesElsewhere);
    }, 30_000);
  };
  world.boot.claude = () => {
    const orders = get(T.orders);
    world.launch(orders, orders.turns.at(-1)!, ordersQuestion(ordersAsked));
  };
}

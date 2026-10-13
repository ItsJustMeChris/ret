import type { Responder, DemoThread } from "./engine";
import type { Run, Script } from "./driver";
import type { Question } from "./items";
import * as W from "./workspace";

/**
 * What the scripted agents do: the turn running when the demo opens, what happens after you
 * answer the waiting approval and question, and replies to anything you send. Replies are
 * canned, but they're grounded in the project they run in: real files are read, edited (the
 * editor and file tree see it), searched and "tested".
 */

const clock = () => new Date().toTimeString().slice(0, 8);
const ms = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo));

/** A reasoning step: Codex summarizes with a bold heading, Claude Code thinks in plain prose. */
const thought = (r: Run, heading: string, body: string) => r.think(r.codex ? `**${heading}**\n\n${body}` : body);

function vitest(cwd: string, files: [string, number][], script: string | null = null): string {
  const total = files.reduce((n, [, c]) => n + c, 0);
  const head = script ? `\n> ${script}\n` : "";
  return `${head}\n RUN  v3.2.4 ${cwd}\n\n${files.map(([f, n]) => ` ✓ ${f} (${n} tests) ${ms(6, 420)}ms`).join("\n")}\n\n Test Files  ${files.length} passed (${files.length})\n      Tests  ${total} passed (${total})\n   Start at  ${clock()}\n   Duration  ${(0.4 + Math.random() * 1.4).toFixed(2)}s (transform ${ms(40, 220)}ms, setup 0ms, collect ${ms(50, 380)}ms, tests ${ms(6, 420)}ms, environment 0ms, prepare ${ms(80, 140)}ms)\n`;
}

let disclosed = false;
/** The first canned reply says so, once. */
function tail(): string {
  if (disclosed) return "";
  disclosed = true;
  return "\n\n_This is Ret's web demo: the agents' replies are scripted, but everything around them is the real app._";
}

// ---------------------------------------------------------------------------
// web: the turn running when the demo opens
// ---------------------------------------------------------------------------

const NPM_INSTALL = `
removed 214 packages, added 31 packages, and changed 4 packages in 6s

148 packages are looking for funding
  run \`npm fund\` for details

found 0 vulnerabilities
`;

const VITE_BUILD = `
> web@2.4.0 build
> vite build

vite v8.0.3 building client environment for production...
transforming...
✓ 412 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                   0.46 kB │ gzip:  0.30 kB
dist/assets/index-B7xQe2Lm.css    3.18 kB │ gzip:  1.21 kB
dist/assets/index-DkV4u9aP.js   187.42 kB │ gzip: 59.87 kB │ map: 812.10 kB
✓ built in 1.12s
`;

const devServer = () => `
> web@2.4.0 dev
> vite

  VITE v8.0.3  ready in 386 ms

  ➜  Local:   http://localhost:3000/
  ➜  Network: use --host to expose
HTTP/1.1 200 OK
${new Date().toLocaleTimeString("en-US")} [vite] (client) hmr update /src/routes/Checkout.tsx
`;

export const viteLive: Script = async (r) => {
  await r.sleep(1800);
  await thought(r, "Swapping scripts and dependencies", "`dev`, `build` and `preview` become Vite. Webpack, its CLI and dev server, and the loaders and plugins it needed can all go.");
  await r.write([{ rel: "package.json", after: W.WEB_PACKAGE_AFTER }], 700);
  r.progress(2);
  await r.write(
    [
      { rel: "index.html", after: W.WEB_INDEX_ROOT },
      { rel: "public/index.html", after: null },
    ],
    600,
  );
  await r.write([{ rel: "webpack.config.js", after: null }], 400);
  r.progress(3);
  await r.run("npm install", NPM_INSTALL, { ms: 4200 });
  await r.run("npm run build", VITE_BUILD, { ms: 3400 });
  await r.say("Build passes. Checking the dev server for HMR…", "commentary");
  await r.run("npm run dev & sleep 3 && curl -sI localhost:3000 | head -1 && touch src/routes/Checkout.tsx && sleep 1 && kill %1", devServer(), { ms: 5200 });
  await thought(r, "Checking CSS module names", "The e2e tests select on names like `Checkout__panel--…`, so the generated class names have to match what webpack produced.");
  await r.run("grep -o 'Checkout__panel--[A-Za-z0-9_-]*' dist/assets/*.css | head -1", "dist/assets/index-B7xQe2Lm.css:Checkout__panel--x7Ka2\n", { ms: 600 });
  r.progress(4);
  await r.say(
    `Moved the storefront to Vite 8.

- **\`vite.config.ts\`** carries over the \`@/\` alias, the \`/api\` proxy to \`:4000\`, port \`3000\`, and the CSS module naming (\`[name]__[local]--[hash:base64:5]\`), so class names match the webpack build and the e2e selectors keep working.
- **\`index.html\`** moved to the project root and loads \`/src/main.tsx\` directly.
- **\`package.json\`**: \`dev\`, \`build\` and \`preview\` run Vite; webpack, its CLI, the dev server and five loaders and plugins are gone (214 fewer packages).
- Deleted \`webpack.config.js\`.

\`npm run build\` passes in 1.1 s (it was 9.8 s with webpack), the dev server is up in under half a second, and editing \`Checkout.tsx\` hot-reloads without a full refresh.

One thing to know: \`process.env\` doesn't exist in Vite. Nothing in \`src/\` uses it today, but new variables need the \`VITE_\` prefix and \`import.meta.env\`.`,
  );
};

// ---------------------------------------------------------------------------
// docs: continued in the Codex CLI, which Ret sees as running elsewhere
// ---------------------------------------------------------------------------

export const notesElsewhere: Script = async (r) => {
  // Another app's pace: Ret refreshes what it can see every few seconds.
  await r.sleep(2500);
  await thought(r, "Finding where it fits", "Self-hosting requirements belong under **Upgrading**, next to the webhook note.");
  await r.sleep(1800);
  await r.read("docs/releases/2.4.md");
  await r.sleep(2600);
  await r.edit(
    "docs/releases/2.4.md",
    "## Upgrading\nVerify webhooks with the v2 signature (see [Getting started](../getting-started.md)); v1 goes away in 2.6.\n",
    "## Upgrading\n- Verify webhooks with the v2 signature (see [Getting started](../getting-started.md)); v1 goes away in 2.6.\n- Self-hosting? The API needs **Node 22** or newer now, the same version CI runs on. (#393)\n",
  );
  await r.sleep(2400);
  await r.run("npm run build", "\n> docs@ build\n> vitepress build docs\n\n  vitepress v2.0.0\n\n✓ building client + server bundles...\n✓ rendering pages...\nbuild complete in 3.11s.\n", { ms: 3200 });
  await r.sleep(2000);
  await r.say("Added to **Upgrading** in `docs/releases/2.4.md`: self-hosted installs need Node 22 or newer now, matching CI (#393). Turned that section into a list while I was there. The docs build is clean.");
};

// ---------------------------------------------------------------------------
// api: waiting on approval to run the auth tests
// ---------------------------------------------------------------------------

export const RATE_REASON = "Run the auth tests against the local Postgres on localhost:5432 (the sandbox blocks network access).";

export const rateApproval: Script = async (r) => {
  const itemId = r.id("c");
  const decision = await r.approve("npm test -- auth", RATE_REASON, itemId);
  if (decision === "decline") {
    r.emit("item/completed", { type: "commandExecution", id: itemId, pluginId: null, scriptPath: null, command: "npm test -- auth", cwd: r.cwd, processId: null, source: "agent", status: "declined", commandActions: [{ type: "unknown", command: "npm test -- auth" }], aggregatedOutput: null, exitCode: null, durationMs: null });
    await r.sleep(600);
    await r.say(
      "Okay, I won't run them. The limiter's own tests pass; to check the endpoint end to end, run `npm test -- auth` with Postgres up (`docker compose up -d db`).\n\nThe change is ready either way: `POST /login` allows 5 attempts per 15 minutes per IP + email, then answers `429` with `Retry-After`.",
    );
    return;
  }
  await r.run("npm test -- auth", vitest(r.cwd, [["test/auth.test.ts", 6]], "api@2.4.0 test\n> vitest run auth"), { ms: 3600, itemId });
  r.progress(3);
  await r.say(
    `Done. \`POST /login\` is rate-limited:

- **5 attempts per 15 minutes per IP + email**, as a token bucket in \`src/server/rateLimit.ts\` that refills continuously.
- Over the limit it answers **\`429 Too Many Requests\`** with **\`Retry-After\`** in seconds.
- A successful sign-in resets the bucket, so a typo or two never locks anyone out.

Tests: 4 new unit tests for the limiter, and 3 new cases in \`test/auth.test.ts\` (the 429, the reset, and limits being per email). All 10 pass.

The buckets live in memory, so with more than one API instance each keeps its own count. The *Try a Redis store* fork moves them to Redis.`,
  );
};

// ---------------------------------------------------------------------------
// shop: waiting on a question
// ---------------------------------------------------------------------------

export const ORDERS_QUESTION: Question[] = [
  {
    header: "Approach",
    question: "How should I fix the N+1 in listOrders?",
    options: [
      { label: "One query with joins (Recommended)", description: "Join customers and addresses, aggregate items with json_agg. 1 query per page." },
      { label: "Batch the lookups", description: "Load items, customers and addresses for the whole page with = any($1). 4 queries, simpler SQL." },
      { label: "Use the orders_with_details view", description: "Already used by getOrder. 1 query, but the view is slow to sort and page." },
    ],
  },
];

const SHOP_REPO_BATCH = W.SHOP_REPO_BEFORE.replace(
  /export async function listOrders[\s\S]*?\n}\n/,
  `export async function listOrders(db: Db, { page = 1, pageSize = 100 } = {}): Promise<OrderWithDetails[]> {
  const { rows: orders } = await db.query<Order>(
    "select * from orders order by created_at desc limit $1 offset $2",
    [pageSize, (page - 1) * pageSize],
  );
  if (!orders.length) return [];

  // One query per relation for the whole page, instead of three per order.
  const [items, customers, addresses] = await Promise.all([
    db.query("select * from order_items where order_id = any($1) order by id", [orders.map((o) => o.id)]),
    db.query("select id, name, email from customers where id = any($1)", [[...new Set(orders.map((o) => o.customer_id))]]),
    db.query("select * from addresses where id = any($1)", [orders.map((o) => o.shipping_address_id).filter(Boolean)]),
  ]);
  const customerById = new Map(customers.rows.map((c) => [c.id, c]));
  const addressById = new Map(addresses.rows.map((a) => [a.id, a]));
  return orders.map((order) => ({
    ...order,
    items: items.rows.filter((i) => i.order_id === order.id),
    customer: customerById.get(order.customer_id),
    shippingAddress: order.shipping_address_id ? (addressById.get(order.shipping_address_id) ?? null) : null,
  }));
}
`,
);

const SHOP_REPO_VIEW = W.SHOP_REPO_BEFORE.replace(
  /export async function listOrders[\s\S]*?\n}\n/,
  `export async function listOrders(db: Db, { page = 1, pageSize = 100 } = {}): Promise<OrderWithDetails[]> {
  // The same view getOrder reads, so a list row and the detail page always agree.
  const { rows } = await db.query<OrderWithDetails>(
    "select * from orders_with_details order by created_at desc limit $1 offset $2",
    [pageSize, (page - 1) * pageSize],
  );
  return rows;
}
`,
).replace(`import type { Order, OrderWithDetails } from "./types.js";`, `import type { OrderWithDetails } from "./types.js";`);

const shopTestAfter = (max: number) =>
  W.SHOP_TEST_BEFORE.replace(`import { app } from "./app.js";\n`, `import { app } from "./app.js";\nimport { countQueries } from "./helpers.js";\n`).replace(
    /\n\}\);\n$/,
    `

  it("runs a constant number of queries, however many orders", async () => {
    const n = await countQueries(() => request(app).get("/admin/orders"));
    expect(n).toBeLessThanOrEqual(${max});
  });
});
`,
  );

const queryLog = (queries: number, sql: number, total: number) =>
  `\n> shop@1.12.0 query-log\n> tsx scripts/query-log.ts /admin/orders\n\nGET /admin/orders: ${queries} ${queries === 1 ? "query" : "queries"}, ${sql} ms in SQL, ${total} ms total\n`;

export const ordersQuestion = (askedId: string): Script => async (r) => {
  const answers = await r.ask(ORDERS_QUESTION, askedId);
  const a = (answers?.[0] ?? "").toLowerCase();
  const pick = !answers ? "join" : a.includes("batch") ? "batch" : a.includes("view") ? "view" : "join";
  r.progress(2);
  if (pick === "join") {
    await r.think(
      answers
        ? "Going with a single query: join customers and addresses, and aggregate items with json_agg, grouped by order. A left join keeps orders without a shipping address."
        : "No preference given, so I'll go with the single query: it's the biggest win and keeps listOrders one statement.",
    );
    await r.write([{ rel: "src/orders/repo.ts", after: W.SHOP_REPO_AFTER }], 800);
  } else if (pick === "batch") {
    await r.think("Batching: one query for the page of orders, then one each for items, customers and addresses across the whole page, joined up in memory.");
    await r.write([{ rel: "src/orders/repo.ts", after: SHOP_REPO_BATCH }], 800);
  } else {
    await r.think("Reading from orders_with_details, the view getOrder already uses. Sorting and paging happen on the view.");
    await r.write([{ rel: "src/orders/repo.ts", after: SHOP_REPO_VIEW }], 600);
  }
  r.progress(3);
  const max = pick === "batch" ? 4 : 1;
  await r.write([{ rel: "test/orders.test.ts", after: shopTestAfter(max) }], 500);
  const [q, sql, total] = pick === "join" ? [1, 21, 64] : pick === "batch" ? [4, 18, 71] : [1, 96, 142];
  await r.run("npm run query-log -- /admin/orders", queryLog(q, sql, total), { ms: 2400 });
  await r.run("npm test -- orders", vitest(r.cwd, [["test/orders.test.ts", 2]], "shop@1.12.0 test\n> vitest run orders"), { ms: 2600 });
  r.progress(4);
  const what =
    pick === "join"
      ? "`listOrders` is now **one query**: orders joined to their customer and shipping address, with items aggregated by `json_agg`."
      : pick === "batch"
        ? "`listOrders` now runs **4 queries per page**: the orders, then items, customers and addresses for the whole page with `= any($1)`, stitched together in memory."
        : "`listOrders` now reads from **`orders_with_details`**, the view `getOrder` already uses: one query, and list rows always match the detail page.";
  await r.say(
    `Fixed. ${what}\n\n| | Before | After |\n| --- | --- | --- |\n| Queries per page | 301 | ${q} |\n| Time in SQL | 1,184 ms | ${sql} ms |\n| Request | 1,342 ms | ${total} ms |\n\nI also added a regression test that fails if the page ever runs more than ${max} ${max === 1 ? "query" : "queries"}, so the N+1 can't sneak back in. Both order tests pass.${
      pick === "view" ? "\n\nThe view does the sorting and paging, so if the orders table grows past a few hundred thousand rows it's worth an index on `created_at` underneath it." : ""
    }`,
  );
};

// ---------------------------------------------------------------------------
// auth: the failed thread picks up where it stopped
// ---------------------------------------------------------------------------

export const passkeysRetry: Script = async (r) => {
  r.setPlan([
    ["Read the WebAuthn notes and current routes", "completed"],
    ["Registration and sign-in endpoints", "completed"],
    ["Tests for the new endpoints", "completed"],
    ["Make the tests pass", "inProgress"],
  ]);
  await r.think("Picking up where the last turn stopped. The tests failed because jsdom has no WebCrypto; @simplewebauthn/server needs crypto.subtle for challenges. A setup file that installs Node's webcrypto fixes that without touching the code under test.");
  await r.write([{ rel: "test/setup.ts", after: W.AUTH_VITEST_SETUP }], 500);
  await r.write([{ rel: "vitest.config.ts", after: W.AUTH_VITEST_AFTER }], 400);
  await r.run("npm test", vitest(r.cwd, [["test/passkeys.test.ts", 2]], "auth@0.9.0 test\n> vitest run"), { ms: 2800 });
  r.setPlan([
    ["Read the WebAuthn notes and current routes", "completed"],
    ["Registration and sign-in endpoints", "completed"],
    ["Tests for the new endpoints", "completed"],
    ["Make the tests pass", "completed"],
  ]);
  await r.say(
    `Back on track: both passkey tests pass.

The failures weren't in our code. jsdom doesn't provide WebCrypto, and \`@simplewebauthn/server\` needs \`crypto.subtle\` to generate challenges. \`test/setup.ts\` now installs Node's \`webcrypto\` when it's missing, and \`vitest.config.ts\` loads it.

Where passkeys stand:
- **Register** (signed in): \`POST /auth/passkeys/register/options\`, then \`/auth/passkeys/register\`
- **Sign in**: \`POST /auth/sign-in/passkey/options\`, then \`/auth/sign-in/passkey\` (discoverable credentials, so no username needed)
- Passwords keep working at \`/auth/sign-in/password\`

Next would be persisting credentials in Postgres instead of the in-memory store in \`src/store.ts\`.${tail()}`,
  );
};

// ---------------------------------------------------------------------------
// Replies to anything else: grounded in the thread's project
// ---------------------------------------------------------------------------

interface Edit {
  rel: string;
  apply: (text: string) => string;
  what: string;
}

interface Pack {
  /** Files to read for context. */
  reads: string[];
  search: [query: string, dir: string | null];
  check: { cmd: string; out: (cwd: string) => string; ok: string };
  edits: Edit[];
  explain: string;
  plan: (goal: string) => string;
  /** Answers to questions this project is likely to get. */
  topics: Topic[];
}

interface Topic {
  match: RegExp;
  reads: string[];
  answer: string;
}

const append = (extra: string) => (text: string) => text.replace(/\n*$/, "\n") + extra;

function packFor(t: DemoThread): Pack | null {
  const cwd = t.meta.cwd;
  const redis = cwd === W.REDIS_WT.path;
  if (cwd === W.P.api || redis)
    return {
      reads: ["src/server/auth.ts", "src/server/rateLimit.ts"],
      search: ["loginLimiter", "src"],
      check: {
        cmd: "npm test",
        out: (c) => vitest(c, redis ? [["test/auth.test.ts", 3]] : [["test/auth.test.ts", 6], ["test/rateLimit.test.ts", 4]], "api@2.4.0 test\n> vitest run"),
        ok: redis ? "passes (3 tests)" : "passes (10 tests)",
      },
      edits: [
        {
          rel: "src/server/rateLimit.ts",
          apply: (s) =>
            s.replace(
              /export const loginLimiter = new (\w+)\((redis, )?5, 15 \* 60_000\);/,
              "export const LOGIN_LIMIT = {\n  attempts: Number(process.env.LOGIN_MAX_ATTEMPTS ?? 5),\n  windowMs: Number(process.env.LOGIN_WINDOW_MINUTES ?? 15) * 60_000,\n};\nexport const loginLimiter = new $1($2LOGIN_LIMIT.attempts, LOGIN_LIMIT.windowMs);",
            ),
          what: "The login limit is configurable now: `LOGIN_MAX_ATTEMPTS` and `LOGIN_WINDOW_MINUTES` override the defaults (5 per 15 minutes), read once at startup in `src/server/rateLimit.ts`.",
        },
        {
          rel: "src/server/auth.ts",
          apply: (s) =>
            s.replace(
              `    return res.status(429).json({ error: "too_many_attempts" });\n  }\n`,
              `    return res.status(429).json({ error: "too_many_attempts" });\n  }\n  res.setHeader("RateLimit-Remaining", String(limit.remaining));\n`,
            ),
          what: "`POST /login` sends `RateLimit-Remaining` on every attempt now, so the sign-in form can warn before someone gets locked out.",
        },
      ],
      explain: `Sign-in, end to end:

1. **\`src/server/routes.ts\`** mounts \`POST /login\` on \`login(db)\` in **\`src/server/auth.ts\`**.
2. The body is validated with zod, then the limiter (\`loginLimiter.check\`) runs, keyed by IP + lowercased email${redis ? " (in Redis, in this worktree)" : ""}.
3. \`findUserByEmail\` and \`argon2.verify\` check the password; a wrong one is a \`401\` and counts against the limit.
4. On success the bucket resets, **\`src/server/session.ts\`** signs a 7-day JWT, and it's set as an http-only \`session\` cookie.

\`GET /me\` reads that cookie back. \`POST /logout\` adds the token to an in-memory revocation set, which (like the limiter) doesn't survive a restart.`,
      plan: (goal) => `## Plan

**Goal:** ${goal}

1. Read \`src/server/auth.ts\` and \`src/server/rateLimit.ts\` to see where this fits.
2. Make the change next to the limiter, keeping the \`429\` + \`Retry-After\` behavior as it is.
3. Cover it in \`test/auth.test.ts\`.
4. Run \`npm test\` and report back.

**Risk:** low. The response shape for existing clients doesn't change.`,
      topics: [
        {
          match: /redis|instance|scale|cluster|load balancer/,
          reads: ["src/server/rateLimit.ts"],
          answer: redis
            ? `If Redis is down, \`loginLimiter.check()\` throws: the client is set to fail fast (\`enableOfflineQueue: false\`, two retries), so \`POST /login\` answers \`500\` until Redis is back, rather than hanging.

That's failing *closed*: nobody can sign in, but nobody can guess passwords either. The alternative is failing *open*: catch the error in \`check()\` and allow the attempt, logging it. For sign-in I'd keep it closed and alert on Redis health; for something like a search endpoint, open is usually the better trade.`
            : `This checkout keeps the counts in memory, in a \`Map\` inside \`src/server/rateLimit.ts\`. That has two consequences:

- **Each instance counts on its own.** Behind a load balancer with 3 instances, an attacker effectively gets 15 attempts per window, not 5.
- **A deploy or crash resets every bucket.**

For one instance that's fine. For more, the counts need to live somewhere shared: the *Try a Redis store* fork does exactly that, with a sorted set per key.`,
        },
        {
          match: /brute|attack|secur|botnet|stuffing|distributed|bypass/,
          reads: ["src/server/auth.ts"],
          answer: `It stops the common case: one client guessing one account's password. Keyed on IP + email, an attacker gets 5 tries per 15 minutes per account from each IP.

What it doesn't stop on its own:

- **Many IPs, one account** (a botnet): each IP gets its own 5 tries. A second, per-email-only limit (say 20 per hour) closes that, at the cost of letting an attacker lock a known account for an hour.
- **One IP, many accounts** (credential stuffing): each email has its own bucket. A per-IP limit across all emails (say 50 per hour) catches that.

Both are a few lines on top of the same \`RateLimiter\` class. Want me to add them?`,
        },
        {
          match: /retry-?after|429|header/,
          reads: ["src/server/rateLimit.ts"],
          answer: `\`Retry-After\` is how long until one attempt is back. The bucket refills continuously at 5 tokens per 15 minutes, so one token every 180 seconds; an empty bucket answers \`Retry-After: 180\`. If it's partly refilled (say 0.4 tokens), it's the time for the rest: \`ceil(0.6 × 180) = 108\`.

It's always whole seconds, and only sent with the \`429\`.`,
        },
      ],
    };
  if (cwd === W.P.web)
    return {
      reads: ["src/App.tsx", "src/routes/Checkout.tsx"],
      search: ["Checkout", "src"],
      check: { cmd: "npm run build", out: () => VITE_BUILD, ok: "still builds (1.1 s)" },
      edits: [
        {
          rel: "src/api.ts",
          apply: (s) => s.replace(`{ credentials: "include", ...init }`, `{ credentials: "include", signal: AbortSignal.timeout(10_000), ...init }`),
          what: "API calls from the storefront give up after 10 seconds now (`AbortSignal.timeout` in `src/api.ts`) instead of leaving the checkout button spinning forever.",
        },
        {
          rel: "vite.config.ts",
          apply: (s) => s.replace("  build: {", "  preview: { port: 3000, strictPort: true },\n  build: {"),
          what: "`vite preview` serves on `:3000` too, so the e2e tests can run against a production build without changing their base URL.",
        },
      ],
      explain: `The storefront in short:

- **\`src/main.tsx\`** mounts \`<App />\` inside a \`BrowserRouter\`.
- **\`src/App.tsx\`** has two routes: \`/\` (\`Catalog\`) and \`/checkout\` (\`Checkout\`).
- Data comes from **\`src/api.ts\`**, a thin \`fetch\` wrapper that prefixes \`/api\`; the dev server proxies that to the API on \`:4000\`.
- Styles are CSS modules (\`Checkout.module.css\`) plus a few globals in \`src/styles.css\`.
- \`e2e/checkout.spec.ts\` drives the checkout with Playwright.`,
      plan: (goal) => `## Plan

**Goal:** ${goal}

1. Find the components and routes involved (\`src/App.tsx\`, \`src/routes/\`).
2. Make the change, keeping CSS module class names stable for the e2e selectors.
3. Run \`npm run build\` and the checkout e2e test.

**Risk:** low; nothing outside the storefront is affected.`,
      topics: [
        {
          match: /hmr|hot|reload|dev server|slow|fast|speed/,
          reads: ["vite.config.ts"],
          answer: `With Vite the dev server doesn't bundle at all: it serves \`src/\` as native ES modules and transforms each file on request, so it's up in about 400 ms however big the app gets. Saving a component swaps just that module (React Fast Refresh keeps its state); saving a CSS module swaps the stylesheet without a reload.

Webpack rebuilt the bundle on every save, which is where the 2 to 3 second waits came from.`,
        },
        {
          match: /\benv\b|environment|process\.env|secret/,
          reads: ["vite.config.ts", "src/api.ts"],
          answer: `In Vite, \`process.env\` doesn't exist in browser code. Variables come from \`.env\` files through \`import.meta.env\`, and only ones prefixed \`VITE_\` reach the client (so a stray \`DATABASE_URL\` can't leak into the bundle).

Nothing in \`src/\` reads env vars today: \`src/api.ts\` calls relative \`/api\` paths and the dev server proxies them. If you need the API URL per environment, add \`VITE_API_URL\` to \`.env.production\` and read \`import.meta.env.VITE_API_URL\`.`,
        },
      ],
    };
  if (cwd === W.P.shop)
    return {
      reads: ["src/orders/routes.ts", "src/orders/repo.ts"],
      search: ["listOrders", "src"],
      check: { cmd: "npm test", out: (c) => vitest(c, [["test/orders.test.ts", 2]], "shop@1.12.0 test\n> vitest run"), ok: "passes (2 tests)" },
      edits: [
        {
          rel: "src/orders/routes.ts",
          apply: (s) =>
            s.replace(
              "    res.json(await listOrders(db, { page }));",
              "    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize ?? 100)));\n    res.json(await listOrders(db, { page, pageSize }));",
            ),
          what: "`GET /admin/orders` takes a `pageSize` now (1 to 500, default 100), so the CSV export can fetch bigger pages.",
        },
        {
          rel: "src/server.ts",
          apply: (s) => s.replace("app.use(express.json());", 'app.disable("x-powered-by");\napp.use(express.json());'),
          what: "The admin server stopped announcing itself with `X-Powered-By: Express`.",
        },
      ],
      explain: `Orders go through three files:

- **\`src/orders/routes.ts\`**: \`GET /admin/orders?page=\` and \`GET /admin/orders/:id\`.
- **\`src/orders/repo.ts\`**: the SQL. \`listOrders\` builds a page with each order's customer, shipping address and items; \`getOrder\` reads the \`orders_with_details\` view.
- **\`src/orders/types.ts\`**: \`Order\` and \`OrderWithDetails\`.

\`npm run query-log -- /admin/orders\` (\`scripts/query-log.ts\`) counts the queries a request runs: the quickest way to spot an N+1.`,
      plan: (goal) => `## Plan

**Goal:** ${goal}

1. Read \`src/orders/routes.ts\` and \`src/orders/repo.ts\`.
2. Make the change in the repo layer, keeping \`listOrders\` to a constant number of queries.
3. Check with \`npm run query-log -- /admin/orders\` and \`npm test\`.

**Risk:** low; the response shape stays the same.`,
      topics: [
        {
          match: /n\+1|30[01]|quer/,
          reads: ["src/orders/repo.ts"],
          answer: `It's the classic N+1. \`listOrders\` first fetched a page of 100 orders (1 query), then looped over them and, for each one, fetched its items, its customer and its shipping address separately: 3 queries × 100 orders. 1 + 300 = 301.

Each query is fast on its own (a few milliseconds), which is why it never showed up in a profiler as one slow query: the cost is 301 round trips to Postgres per page. Loading the related rows for the whole page at once (a join, or \`= any($1)\` batches) makes the count constant, however many orders are on the page.`,
        },
        {
          match: /index|slow|explain|performance|fast|scale/,
          reads: ["src/orders/repo.ts"],
          answer: `The query that matters is \`listOrders\`: it sorts orders by \`created_at\` and takes a page. Without an index on \`orders (created_at desc)\`, Postgres sorts the whole table on every page view; with one, it reads the first 100 rows in order and stops.

The joins are on primary keys (\`customers.id\`, \`addresses.id\`) plus \`order_items.order_id\`, which needs its own index too. That's the usual suspect when a page of orders gets slower as items pile up, and \`explain analyze\` on the query will say which one is missing.`,
        },
      ],
    };
  if (cwd === W.P.docs)
    return {
      reads: ["docs/index.md", ".vitepress/config.ts"],
      search: ["Retry-After", "docs"],
      check: {
        cmd: "npm run build",
        out: () => "\n> docs@ build\n> vitepress build docs\n\n  vitepress v2.0.0\n\n✓ building client + server bundles...\n✓ rendering pages...\nbuild complete in 3.04s.\n",
        ok: "builds cleanly",
      },
      edits: [
        {
          rel: "docs/guides/rate-limits.md",
          apply: append("\n## Headers\n\n- `Retry-After`: seconds until you can try again.\n- `RateLimit-Remaining`: attempts left in the current window (sign-in only).\n"),
          what: "The rate limits guide has a **Headers** section now, covering `Retry-After` and `RateLimit-Remaining`.",
        },
        {
          rel: "docs/getting-started.md",
          apply: append("4. While developing, use a test-mode key (`sk_test_…`): test-mode orders never charge a card.\n"),
          what: "Getting started has a fourth step about test-mode keys.",
        },
      ],
      explain: `The docs are a VitePress site:

- Pages live in **\`docs/\`**: \`index.md\`, \`getting-started.md\`, \`guides/\` and \`releases/\`.
- **\`.vitepress/config.ts\`** sets the title and the top nav (Guides, Releases).
- \`npm run dev\` previews with hot reload; \`npm run build\` writes static HTML to \`docs/.vitepress/dist\`.

A new page is a Markdown file under \`docs/\`. Link it from \`docs/index.md\`, and from the nav if it's a section of its own.`,
      plan: (goal) => `## Plan

**Goal:** ${goal}

1. Find the pages this touches under \`docs/\`.
2. Write the change, matching the tone of the 2.3 and 2.4 notes.
3. Run \`npm run build\` to catch dead links.`,
      topics: [
        {
          match: /publish|deploy|release|ship|live/,
          reads: ["package.json"],
          answer: `\`npm run build\` writes the static site to \`docs/.vitepress/dist\`; that folder is what gets deployed, so a page goes live with the next build of \`main\`.

For 2.4 that means merging \`docs/releases/2.4.md\` (it's already linked from \`docs/index.md\`), then adding a 2.4 section to \`CHANGELOG.md\` the way 2.3 has one.`,
        },
      ],
    };
  if (cwd === W.P.auth)
    return {
      reads: ["src/passkeys.ts", "src/routes.ts"],
      search: ["rpID", "src"],
      check: { cmd: "npm test", out: (c) => vitest(c, [["test/passkeys.test.ts", 2]], "auth@0.9.0 test\n> vitest run"), ok: "passes (2 tests)" },
      edits: [
        {
          rel: "src/passkeys.ts",
          apply: (s) => s.replace('const rpName = "Acme";', 'const rpName = process.env.RP_NAME ?? "Acme";'),
          what: "The name shown in the passkey prompt comes from `RP_NAME` now (default “Acme”), so staging can say “Acme Staging”.",
        },
        {
          rel: "docs/webauthn.md",
          apply: append("- Allow up to 10 passkeys per account, listed with their last-used date in account settings.\n"),
          what: "Noted the per-account passkey limit in `docs/webauthn.md`.",
        },
      ],
      explain: `Passkeys, as built so far:

1. Signed in, the browser asks **\`POST /auth/passkeys/register/options\`** for a challenge (\`startRegistration\` in \`src/passkeys.ts\`), creates a passkey, and posts it to **\`/auth/passkeys/register\`**, which verifies it and stores the public key.
2. To sign in, **\`/auth/sign-in/passkey/options\`** returns a challenge with no user attached (discoverable credentials), and **\`/auth/sign-in/passkey\`** checks the signature and bumps the counter.
3. Passwords keep working at **\`/auth/sign-in/password\`**.

Challenges and credentials live in \`src/store.ts\`, in memory for now.`,
      plan: (goal) => `## Plan

**Goal:** ${goal}

1. Read \`src/passkeys.ts\` and \`docs/webauthn.md\`.
2. Make the change, keeping password sign-in untouched.
3. Extend \`test/passkeys.test.ts\` and run \`npm test\`.`,
      topics: [
        {
          match: /safari|ios|android|browser|support|phone|device|sync/,
          reads: ["docs/webauthn.md"],
          answer: `Every current browser supports passkeys: Safari, Chrome, Edge and Firefox, on macOS, iOS, Android and Windows. They sync through the platform's password manager (iCloud Keychain, Google Password Manager) or a third-party one, so a passkey made on a phone also works on that person's laptop.

On our side, \`residentKey: "preferred"\` (already set) makes them discoverable, so the sign-in page needs no username, and passwords stay as a fallback for anyone without one.`,
        },
      ],
    };
  return null;
}

function topic(tp: Topic): Script {
  return async (r) => {
    await thought(r, "Checking the code", "Reading the relevant file before answering.");
    for (const f of tp.reads) await r.read(f, ms(250, 500));
    await r.say(tp.answer + tail());
  };
}

const GREETING = /^(hi|hello|hey|yo|hiya|howdy|sup|good (morning|afternoon|evening))\b/;
const ABOUT = /\b(what is (this|ret)|what'?s (this|ret)|who are you|are you (real|an? ai|a bot|human)|is this (real|live)|demo)\b/;

/** Each project's canned edits, used in order (each once per visit). */
const editsUsed = new Map<string, number>();
function nextEdit(t: DemoThread, pack: Pack): Edit | null {
  const n = editsUsed.get(t.meta.cwd) ?? 0;
  const edit = pack.edits[n];
  if (!edit) return null;
  editsUsed.set(t.meta.cwd, n + 1);
  return edit;
}

const clip = (s: string, n = 90) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1).trimEnd() + "…" : one;
};

function explain(pack: Pack): Script {
  return async (r) => {
    await thought(r, "Reading the relevant code", "Starting from where this is used, then reading the files involved.");
    await r.search(...pack.search);
    for (const f of pack.reads) await r.read(f, ms(250, 500));
    await r.say(pack.explain + tail());
  };
}

function change(t: DemoThread, pack: Pack, ask: string): Script {
  const edit = nextEdit(t, pack);
  if (!edit) return explain(pack);
  return async (r) => {
    await thought(r, "Finding the right spot", `Looking at where “${clip(ask, 60)}” would land in this codebase.`);
    await r.search(...pack.search);
    await r.read(edit.rel);
    const path = `${r.cwd}/${edit.rel}`;
    await r.write([{ rel: edit.rel, after: edit.apply(r.fs.read(path) ?? "") }], 700);
    await r.run(pack.check.cmd, pack.check.out(r.cwd), { ms: 2400 });
    await r.say(`Done. ${edit.what}\n\n\`${pack.check.cmd}\` ${pack.check.ok}.${tail()}`);
  };
}

function check(pack: Pack): Script {
  return async (r) => {
    await r.run(pack.check.cmd, pack.check.out(r.cwd), { ms: 3000 });
    await r.say(`\`${pack.check.cmd}\` ${pack.check.ok}. Nothing failing or flaky in this run.${tail()}`);
  };
}

function plan(pack: Pack, goal: string): Script {
  return async (r) => {
    await thought(r, "Planning", "Reading enough of the code to propose something concrete before changing anything.");
    for (const f of pack.reads) await r.read(f, ms(250, 450));
    await r.proposePlan(pack.plan(clip(goal, 140)));
    await r.say(r.codex ? "That's the plan. Implement it as is, or tell me what to change." : "Here's the plan. Want me to go ahead, or adjust anything first?");
  };
}

function implement(t: DemoThread, pack: Pack): Script {
  const edits = [nextEdit(t, pack), nextEdit(t, pack)].filter((e): e is Edit => !!e);
  return async (r) => {
    await thought(r, "Implementing the plan", "Working through the steps in order.");
    for (const e of edits) {
      await r.read(e.rel);
      await r.write([{ rel: e.rel, after: e.apply(r.fs.read(`${r.cwd}/${e.rel}`) ?? "") }], 600);
    }
    await r.run(pack.check.cmd, pack.check.out(r.cwd), { ms: 2600 });
    const done = edits.length ? edits.map((e) => `- ${e.what}`).join("\n") : "- No code needed changing for this one.";
    await r.say(`Implemented:\n\n${done}\n\n\`${pack.check.cmd}\` ${pack.check.ok}.${tail()}`);
  };
}

/** A folder Ret doesn't have a story for (one added in the demo). */
function bare(ask: string, planning: boolean): Script {
  return async (r) => {
    await thought(r, "Looking around", "Checking what's in this folder first.");
    const entries = r.fs.list(r.cwd) ?? [];
    await r.run("ls -la", entries.length ? entries.map((e) => (e.dir ? `drwxr-xr-x  ${e.name}/` : `-rw-r--r--  ${e.name}`)).join("\n") + "\n" : "total 0\n", { ms: 400 });
    const text = `This folder is empty so far, so there's nothing to change yet for “${clip(ask, 80)}”.\n\nTell me what you'd like here and I'll set it up: a \`package.json\`, a first module, and a test to go with it.`;
    if (planning) await r.proposePlan(`## Plan\n\n**Goal:** ${clip(ask, 140)}\n\n1. Scaffold the project (\`package.json\`, \`tsconfig.json\`, \`src/\`).\n2. Write the first module.\n3. Add a test and run it.`);
    else await r.say(text + tail());
  };
}

let rotation = 0;

const reply = (text: string): Script => async (r) => {
  await r.sleep(500);
  await r.say(text);
};

const ABOUT_TEXT = `This is **Ret's web demo**: the real Ret app, running in your browser. Everything you can click (Focus, Canvas, Code and Inbox, forks, the editor, approvals and questions) is the app itself, built from the same code as the desktop version.

What's different: there's no Codex or Claude Code behind it. The agents here are scripted and work in a pretend \`~/code\` folder, so their replies are canned (though they really do read, edit and "test" the files in that folder).

To try the real thing, download Ret: it runs your own Codex and Claude Code, with your own sign-ins.`;

function greeting(t: DemoThread, known: boolean): string {
  const folder = t.meta.cwd.replace(/^\/Users\/you/, "~");
  const tips = known
    ? " A few things to try:\n\n- Ask me to **change** something (\"make the limit configurable\")\n- Ask me to **run the tests**\n- Ask **how** something works, or **why**\n- Turn on **Plan** (Shift+Tab) and I'll propose a plan before touching anything"
    : " It's empty so far: tell me what to build.";
  return `Hi! I'm working in \`${folder}\`.${tips}${tail()}`;
}

export const respond: Responder = (t, text, mode) => {
  const pack = packFor(t);
  const lower = text.toLowerCase();
  if (ABOUT.test(lower)) return reply(ABOUT_TEXT);
  if (GREETING.test(lower) && lower.length < 40) return reply(greeting(t, !!pack));
  if (!pack) return bare(text, mode === "plan");
  if (mode === "plan") return plan(pack, text);
  const tp = pack.topics.find((x) => x.match.test(lower));
  if (tp && !/^implement the plan/.test(lower)) return topic(tp);
  if (/^implement the plan/.test(lower) || /^(go ahead|do it|yes|sounds good|ship it|lgtm)\b/.test(lower)) return implement(t, pack);
  if (/\b(run|rerun|re-run)\b.*\b(tests?|specs?|build|ci)\b|^(tests?|run tests?)\b/.test(lower)) return check(pack);
  if (/\b(fix|add|change|update|refactor|rename|implement|make|remove|delete|bump|migrate|write|create|use|switch|move|improve|clean|tweak|support)\b/.test(lower)) return change(t, pack, text);
  if (/\?\s*$|^(why|how|what|where|which|when|who|can|could|does|do|is|are|explain|review|summari[sz]e|tell me|walk me)\b/.test(lower)) return explain(pack);
  const pickers = [() => explain(pack), () => change(t, pack, text), () => check(pack)];
  return pickers[rotation++ % pickers.length]();
};

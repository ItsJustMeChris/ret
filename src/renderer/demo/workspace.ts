import type { DemoFs } from "./fs";

/**
 * The demo machine: five projects under ~/code and one worktree, with real-looking files.
 * Files a thread changed exist here in their changed state; the versions from before a change
 * (for the diffs in the transcripts) are exported alongside.
 */

export const HOME = "/Users/you";
export const CODE = `${HOME}/code`;
export const P = {
  api: `${CODE}/api`,
  web: `${CODE}/web`,
  shop: `${CODE}/shop`,
  docs: `${CODE}/docs`,
  auth: `${CODE}/auth`,
} as const;
export type ProjectName = keyof typeof P;

export const WORKTREES = `${HOME}/Library/Application Support/Ret/worktrees`;
export const REDIS_WT = { path: `${WORKTREES}/api/try-a-redis-store-m4k2p`, branch: "ret/try-a-redis-store-m4k2p", repoRoot: P.api };

/** The git branch each project is on. */
export const BRANCH: Record<string, string> = {
  [P.api]: "main",
  [P.web]: "vite-8",
  [P.shop]: "main",
  [P.docs]: "main",
  [P.auth]: "passkeys",
  [REDIS_WT.path]: REDIS_WT.branch,
};

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------

const API_PACKAGE = (redis: boolean) => `{
  "name": "api",
  "version": "2.4.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "lint": "eslint src test"
  },
  "dependencies": {
    "argon2": "^0.41.1",
    "cookie-parser": "^1.4.7",
    "express": "^5.1.0",${redis ? '\n    "ioredis": "^5.6.1",' : ""}
    "jose": "^6.0.11",
    "pg": "^8.16.3",
    "zod": "^4.1.5"
  },
  "devDependencies": {
    "@types/cookie-parser": "^1.4.9",
    "@types/express": "^5.0.3",
    "@types/node": "^24.3.0",
    "@types/supertest": "^6.0.3",
    "supertest": "^7.1.4",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
`;

export const API_AUTH_BEFORE = `import type { RequestHandler } from "express";
import argon2 from "argon2";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { findUserByEmail, findUserById } from "../db/users.js";
import { createSession, destroySession, readSession } from "./session.js";

const Credentials = z.object({
  email: z.email(),
  password: z.string().min(1),
});

export const login = (db: Db): RequestHandler => async (req, res) => {
  const parsed = Credentials.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const { email, password } = parsed.data;

  const user = await findUserByEmail(db, email);
  const ok = user ? await argon2.verify(user.passwordHash, password) : false;
  if (!user || !ok) return res.status(401).json({ error: "invalid_credentials" });

  const token = await createSession(user.id);
  res.cookie("session", token, { httpOnly: true, secure: true, sameSite: "lax" });
  res.json({ id: user.id, email: user.email });
};

export const logout: RequestHandler = async (req, res) => {
  await destroySession(req.cookies?.session);
  res.clearCookie("session").status(204).end();
};

export const me = (db: Db): RequestHandler => async (req, res) => {
  const session = await readSession(req.cookies?.session);
  if (!session) return res.status(401).json({ error: "unauthenticated" });
  const user = await findUserById(db, session.userId);
  res.json(user ? { id: user.id, email: user.email } : null);
};
`;

const authWithLimiter = (awaited: boolean) =>
  API_AUTH_BEFORE.replace(
    `import { createSession, destroySession, readSession } from "./session.js";\n`,
    `import { createSession, destroySession, readSession } from "./session.js";\nimport { loginLimiter } from "./rateLimit.js";\n`,
  )
    .replace(
      `  const { email, password } = parsed.data;\n\n`,
      `  const { email, password } = parsed.data;\n\n  // Per IP + email, so one noisy client can't lock everyone else out of an account.\n  const key = \`\${req.ip}:\${email.toLowerCase()}\`;\n  const limit = ${awaited ? "await " : ""}loginLimiter.check(key);\n  if (!limit.allowed) {\n    res.setHeader("Retry-After", String(limit.retryAfterSeconds));\n    return res.status(429).json({ error: "too_many_attempts" });\n  }\n\n`,
    )
    .replace(`  const token = await createSession(user.id);\n`, `  ${awaited ? "await " : ""}loginLimiter.reset(key);\n  const token = await createSession(user.id);\n`);

export const API_AUTH_AFTER = authWithLimiter(false);
export const API_AUTH_REDIS = authWithLimiter(true);

export const API_RATE_LIMIT = `/**
 * Token bucket for login attempts, keyed by IP + email.
 * In memory: right for a single instance (see the Redis fork for more).
 */
export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): LimitResult {
    const now = this.now();
    const refillPerMs = this.capacity / this.windowMs;
    const b = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.updatedAt) * refillPerMs);
    b.updatedAt = now;
    this.buckets.set(key, b);

    if (b.tokens < 1) {
      const retryAfterSeconds = Math.ceil((1 - b.tokens) / refillPerMs / 1000);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    b.tokens -= 1;
    return { allowed: true, remaining: Math.floor(b.tokens), retryAfterSeconds: 0 };
  }

  reset(key: string) {
    this.buckets.delete(key);
  }

  /** Forget buckets that have refilled, so the map doesn't grow forever. */
  sweep() {
    const now = this.now();
    for (const [key, b] of this.buckets) if (now - b.updatedAt > this.windowMs) this.buckets.delete(key);
  }
}

/** 5 attempts per 15 minutes per IP + email. */
export const loginLimiter = new RateLimiter(5, 15 * 60_000);
setInterval(() => loginLimiter.sweep(), 60_000).unref();
`;

export const API_RATE_LIMIT_REDIS = `import type { Redis } from "ioredis";
import { redis } from "./store/redis.js";

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Sliding window in Redis, so every API instance sees the same counts.
 * One sorted set per key; members are attempt timestamps, trimmed to the window.
 */
export class RedisRateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly prefix = "rl:login:",
  ) {}

  async check(key: string): Promise<LimitResult> {
    const now = Date.now();
    const k = this.prefix + key;
    const res = await this.redis
      .multi()
      .zremrangebyscore(k, 0, now - this.windowMs)
      .zcard(k)
      .zrange(k, 0, 0, "WITHSCORES")
      .exec();
    const count = Number(res?.[1]?.[1] ?? 0);
    const oldest = Number((res?.[2]?.[1] as string[] | undefined)?.[1] ?? now);

    if (count >= this.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    await this.redis.multi().zadd(k, now, \`\${now}:\${count}\`).pexpire(k, this.windowMs).exec();
    return { allowed: true, remaining: this.limit - count - 1, retryAfterSeconds: 0 };
  }

  async reset(key: string) {
    await this.redis.del(this.prefix + key);
  }
}

/** 5 attempts per 15 minutes per IP + email, shared by every instance. */
export const loginLimiter = new RedisRateLimiter(redis, 5, 15 * 60_000);
`;

export const API_REDIS_STORE = `import { Redis } from "ioredis";

/** One connection per process. Commands fail fast instead of queueing while Redis is down. */
export const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,
});

redis.on("error", (err) => console.error("redis:", err.message));
`;

export const API_AUTH_TEST_BEFORE = `import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { resetDb, seedUser, testDb } from "./helpers.js";

describe("POST /login", () => {
  const app = createApp({ db: testDb });

  beforeEach(async () => {
    await resetDb();
    await seedUser({ email: "ada@example.com", password: "correct horse" });
  });

  it("signs in with the right password", async () => {
    const res = await request(app).post("/login").send({ email: "ada@example.com", password: "correct horse" });
    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]?.[0]).toMatch(/^session=/);
  });

  it("rejects a wrong password", async () => {
    const res = await request(app).post("/login").send({ email: "ada@example.com", password: "nope" });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body", async () => {
    const res = await request(app).post("/login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
  });
});
`;

export const API_AUTH_TEST_AFTER = API_AUTH_TEST_BEFORE.replace(
  `import { createApp } from "../src/server/app.js";\n`,
  `import { createApp } from "../src/server/app.js";\nimport { loginLimiter } from "../src/server/rateLimit.js";\n`,
)
  .replace(`    await resetDb();\n`, `    await resetDb();\n    loginLimiter.reset("::ffff:127.0.0.1:ada@example.com");\n`)
  .replace(
    /\n\}\);\n$/,
    `

  it("returns 429 with Retry-After after 5 failed attempts", async () => {
    const attempt = () => request(app).post("/login").send({ email: "ada@example.com", password: "nope" });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    const res = await attempt();
    expect(res.status).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("a successful sign-in resets the limit", async () => {
    for (let i = 0; i < 4; i++) await request(app).post("/login").send({ email: "ada@example.com", password: "nope" });
    await request(app).post("/login").send({ email: "ada@example.com", password: "correct horse" });
    const res = await request(app).post("/login").send({ email: "ada@example.com", password: "nope" });
    expect(res.status).toBe(401);
  });

  it("limits per email, not just per IP", async () => {
    await seedUser({ email: "grace@example.com", password: "hopper" });
    for (let i = 0; i < 5; i++) await request(app).post("/login").send({ email: "ada@example.com", password: "nope" });
    const res = await request(app).post("/login").send({ email: "grace@example.com", password: "hopper" });
    expect(res.status).toBe(200);
  });
});
`,
  );

export const API_RATE_LIMIT_TEST = `import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/server/rateLimit.js";

describe("RateLimiter", () => {
  it("allows up to capacity, then blocks", () => {
    const now = 0;
    const rl = new RateLimiter(5, 15 * 60_000, () => now);
    for (let i = 0; i < 5; i++) expect(rl.check("k").allowed).toBe(true);
    const blocked = rl.check("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(180);
  });

  it("refills over time", () => {
    let now = 0;
    const rl = new RateLimiter(5, 15 * 60_000, () => now);
    for (let i = 0; i < 5; i++) rl.check("k");
    now += 3 * 60_000;
    expect(rl.check("k").allowed).toBe(true);
  });

  it("keeps keys independent", () => {
    const rl = new RateLimiter(1, 60_000);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("b").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(false);
  });

  it("reset clears a key", () => {
    const rl = new RateLimiter(1, 60_000);
    rl.check("a");
    rl.reset("a");
    expect(rl.check("a").allowed).toBe(true);
  });
});
`;

export const API_CI_BEFORE = `name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:17
        env:
          POSTGRES_USER: acme
          POSTGRES_PASSWORD: acme
          POSTGRES_DB: acme_test
        ports: ["5432:5432"]
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test
        env:
          TEST_DATABASE_URL: postgres://acme:acme@localhost:5432/acme_test
`;

export const API_CI_AFTER = API_CI_BEFORE.replace("node-version: 20", "node-version: 22");

const API_FILES: Record<string, string> = {
  ".github/workflows/ci.yml": API_CI_AFTER,
  ".nvmrc": "22\n",
  "README.md": `# api

The Acme storefront API: sign-in, sessions, orders and webhooks.

## Develop

\`\`\`bash
npm install
cp .env.example .env
docker compose up -d db
npm run dev        # http://localhost:4000
npm test
\`\`\`

Migrations live in \`migrations/\` and run on start.

## Auth

- \`POST /login\` with \`{ email, password }\` sets an http-only \`session\` cookie.
- \`POST /logout\` clears it; \`GET /me\` returns the signed-in user.
`,
  ".env.example": `PORT=4000
DATABASE_URL=postgres://acme:acme@localhost:5432/acme
SESSION_SECRET=change-me
REDIS_URL=redis://localhost:6379
`,
  ".gitignore": `node_modules
dist
.env
coverage
`,
  "docker-compose.yml": `services:
  db:
    image: postgres:17
    environment:
      POSTGRES_USER: acme
      POSTGRES_PASSWORD: acme
      POSTGRES_DB: acme
    ports: ["5432:5432"]
  redis:
    image: redis:8-alpine
    ports: ["6379:6379"]
`,
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
`,
  "src/index.ts": `import { createApp } from "./server/app.js";
import { db } from "./db/client.js";

const port = Number(process.env.PORT ?? 4000);
const app = createApp({ db });

app.listen(port, () => {
  console.log(\`api listening on http://localhost:\${port}\`);
});
`,
  "src/server/app.ts": `import express from "express";
import cookieParser from "cookie-parser";
import type { Db } from "../db/client.js";
import { routes } from "./routes.js";

export function createApp({ db }: { db: Db }) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());
  app.use(routes(db));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });
  return app;
}
`,
  "src/server/routes.ts": `import { Router } from "express";
import type { Db } from "../db/client.js";
import { login, logout, me } from "./auth.js";
import { listOrders } from "./orders.js";

export function routes(db: Db) {
  const r = Router();
  r.get("/healthz", (_req, res) => res.json({ ok: true }));
  r.post("/login", login(db));
  r.post("/logout", logout);
  r.get("/me", me(db));
  r.get("/orders", listOrders(db));
  return r;
}
`,
  "src/server/session.ts": `import { jwtVerify, SignJWT } from "jose";

const secret = new TextEncoder().encode(process.env.SESSION_SECRET ?? "dev-only-secret");
const revoked = new Set<string>();

export async function createSession(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
}

export async function readSession(token: string | undefined): Promise<{ userId: string } | null> {
  if (!token || revoked.has(token)) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return payload.sub ? { userId: payload.sub } : null;
  } catch {
    return null;
  }
}

export async function destroySession(token: string | undefined) {
  if (token) revoked.add(token);
}
`,
  "src/server/orders.ts": `import type { RequestHandler } from "express";
import type { Db } from "../db/client.js";

export const listOrders = (db: Db): RequestHandler => async (req, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const { rows } = await db.query(
    "select id, status, total_cents, created_at from orders order by created_at desc limit 50 offset $1",
    [(page - 1) * 50],
  );
  res.json({ page, orders: rows });
};
`,
  "src/db/client.ts": `import pg from "pg";

export type Db = pg.Pool;

export const db: Db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});
`,
  "src/db/users.ts": `import type { Db } from "./client.js";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
}

export async function findUserByEmail(db: Db, email: string): Promise<User | null> {
  const { rows } = await db.query<User>(
    'select id, email, password_hash as "passwordHash" from users where lower(email) = lower($1)',
    [email],
  );
  return rows[0] ?? null;
}

export async function findUserById(db: Db, id: string): Promise<User | null> {
  const { rows } = await db.query<User>('select id, email, password_hash as "passwordHash" from users where id = $1', [id]);
  return rows[0] ?? null;
}
`,
  "test/helpers.ts": `import argon2 from "argon2";
import pg from "pg";

export const testDb = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL ?? "postgres://acme:acme@localhost:5432/acme_test" });

export async function resetDb() {
  await testDb.query("truncate users restart identity cascade");
}

export async function seedUser({ email, password }: { email: string; password: string }) {
  await testDb.query("insert into users (email, password_hash) values ($1, $2)", [email, await argon2.hash(password)]);
}
`,
  "test/auth.test.ts": API_AUTH_TEST_BEFORE,
  "src/server/auth.ts": API_AUTH_BEFORE,
  "package.json": API_PACKAGE(false),
};

// ---------------------------------------------------------------------------
// web
// ---------------------------------------------------------------------------

export const WEB_PACKAGE_BEFORE = `{
  "name": "web",
  "version": "2.4.0",
  "private": true,
  "scripts": {
    "dev": "webpack serve --mode development",
    "build": "NODE_ENV=production webpack --mode production",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^19.1.1",
    "react-dom": "^19.1.1",
    "react-router": "^7.8.2"
  },
  "devDependencies": {
    "@types/react": "^19.1.12",
    "@types/react-dom": "^19.1.9",
    "css-loader": "^7.1.2",
    "html-webpack-plugin": "^5.6.4",
    "mini-css-extract-plugin": "^2.9.4",
    "style-loader": "^4.0.0",
    "ts-loader": "^9.5.4",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4",
    "webpack": "^5.101.3",
    "webpack-cli": "^6.0.1",
    "webpack-dev-server": "^5.2.2"
  }
}
`;

export const WEB_PACKAGE_AFTER = `{
  "name": "web",
  "version": "2.4.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^19.1.1",
    "react-dom": "^19.1.1",
    "react-router": "^7.8.2"
  },
  "devDependencies": {
    "@types/react": "^19.1.12",
    "@types/react-dom": "^19.1.9",
    "@vitejs/plugin-react": "^6.0.1",
    "typescript": "^5.9.2",
    "vite": "^8.0.3",
    "vitest": "^3.2.4"
  }
}
`;

export const WEB_WEBPACK = `const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

const isProd = process.env.NODE_ENV === "production";
const cssLoader = isProd ? MiniCssExtractPlugin.loader : "style-loader";

module.exports = {
  entry: "./src/main.tsx",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: isProd ? "assets/[name].[contenthash:8].js" : "assets/[name].js",
    publicPath: "/",
    clean: true,
  },
  resolve: {
    extensions: [".tsx", ".ts", ".js"],
    alias: { "@": path.resolve(__dirname, "src") },
  },
  module: {
    rules: [
      { test: /\\.tsx?$/, use: "ts-loader", exclude: /node_modules/ },
      {
        test: /\\.module\\.css$/,
        use: [cssLoader, { loader: "css-loader", options: { modules: { localIdentName: "[name]__[local]--[hash:base64:5]" } } }],
      },
      { test: /(?<!\\.module)\\.css$/, use: [cssLoader, "css-loader"] },
      { test: /\\.(png|svg|jpe?g|webp|woff2?)$/, type: "asset" },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({ template: "public/index.html" }),
    ...(isProd ? [new MiniCssExtractPlugin({ filename: "assets/[name].[contenthash:8].css" })] : []),
  ],
  devServer: {
    port: 3000,
    historyApiFallback: true,
    hot: true,
    proxy: [{ context: ["/api"], target: "http://localhost:4000", changeOrigin: true }],
  },
  devtool: isProd ? "source-map" : "eval-cheap-module-source-map",
};
`;

export const WEB_VITE = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  css: {
    // Same class names as the webpack build, so snapshots and e2e selectors keep working.
    modules: { generateScopedName: "[name]__[local]--[hash:base64:5]" },
  },
  server: {
    port: 3000,
    strictPort: true,
    proxy: { "/api": { target: "http://localhost:4000", changeOrigin: true } },
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: true,
  },
});
`;

export const WEB_INDEX_PUBLIC = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Acme</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

export const WEB_INDEX_ROOT = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Acme</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

export const WEB_E2E_BEFORE = `import { expect, test } from "@playwright/test";

test("places an order", async ({ page }) => {
  await page.goto("/checkout");
  await page.getByRole("button", { name: "Place order" }).click();
  await page.waitForTimeout(500);
  expect(await page.getByRole("button").textContent()).toBe("Place order");
  await expect(page.getByText("Order placed")).toBeVisible();
});
`;

export const WEB_E2E_AFTER = `import { expect, test } from "@playwright/test";

test("places an order", async ({ page }) => {
  await page.goto("/checkout");
  const orderPlaced = page.waitForResponse((r) => r.url().endsWith("/api/orders") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Place order" }).click();
  // Wait for the request itself, not a fixed delay: on a slow CI runner it took longer than 500 ms.
  expect((await orderPlaced).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "Place order" })).toBeEnabled();
  await expect(page.getByText("Order placed")).toBeVisible();
});
`;

const WEB_FILES: Record<string, string> = {
  "e2e/checkout.spec.ts": WEB_E2E_AFTER,
  "playwright.config.ts": `import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:3000" },
  webServer: { command: "npm run dev", port: 3000, reuseExistingServer: true },
});
`,
  "README.md": `# web

The Acme storefront. React 19, React Router, CSS modules.

\`\`\`bash
npm install
npm run dev     # http://localhost:3000, proxies /api to :4000
npm test
\`\`\`
`,
  ".gitignore": `node_modules
dist
`,
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "types": ["vite/client"],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
`,
  "package.json": WEB_PACKAGE_BEFORE,
  "webpack.config.js": WEB_WEBPACK,
  "vite.config.ts": WEB_VITE,
  "public/index.html": WEB_INDEX_PUBLIC,
  "public/favicon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#111"/><path d="M9 22l7-12 7 12z" fill="#8b9cff"/></svg>
`,
  "src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "@/App";
import "@/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
`,
  "src/App.tsx": `import { Route, Routes } from "react-router";
import { Catalog } from "@/routes/Catalog";
import { Checkout } from "@/routes/Checkout";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Catalog />} />
      <Route path="/checkout" element={<Checkout />} />
    </Routes>
  );
}
`,
  "src/api.ts": `export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(\`/api\${path}\`, { credentials: "include", ...init });
  if (!res.ok) throw new Error(\`\${res.status} \${res.statusText}\`);
  return res.json() as Promise<T>;
}
`,
  "src/routes/Catalog.tsx": `import { useEffect, useState } from "react";
import { api } from "@/api";

type Product = { id: string; name: string; priceCents: number };

export function Catalog() {
  const [products, setProducts] = useState<Product[]>([]);
  useEffect(() => void api<Product[]>("/products").then(setProducts), []);
  return (
    <ul>
      {products.map((p) => (
        <li key={p.id}>
          {p.name} · \${(p.priceCents / 100).toFixed(2)}
        </li>
      ))}
    </ul>
  );
}
`,
  "src/routes/Checkout.tsx": `import { useState } from "react";
import { api } from "@/api";
import styles from "./Checkout.module.css";

export function Checkout() {
  const [placing, setPlacing] = useState(false);
  const place = async () => {
    setPlacing(true);
    try {
      await api("/orders", { method: "POST" });
    } finally {
      setPlacing(false);
    }
  };
  return (
    <section className={styles.panel}>
      <h1 className={styles.title}>Checkout</h1>
      <button className={styles.cta} disabled={placing} onClick={place}>
        {placing ? "Placing…" : "Place order"}
      </button>
    </section>
  );
}
`,
  "src/routes/Checkout.module.css": `.panel {
  max-width: 520px;
  margin: 48px auto;
  padding: 24px;
  border-radius: 12px;
  background: var(--surface);
}

.title {
  margin: 0 0 16px;
  font-size: 22px;
}

.cta {
  width: 100%;
  padding: 12px;
  border-radius: 8px;
  background: var(--accent);
  color: white;
}
`,
  "src/styles.css": `:root {
  --surface: #fff;
  --accent: #4f5fe8;
  font-family: system-ui, sans-serif;
}

body {
  margin: 0;
  background: #f6f6f8;
}
`,
};

// ---------------------------------------------------------------------------
// shop
// ---------------------------------------------------------------------------

export const SHOP_REPO_BEFORE = `import type { Db } from "../db/index.js";
import type { Order, OrderWithDetails } from "./types.js";

export async function listOrders(db: Db, { page = 1, pageSize = 100 } = {}): Promise<OrderWithDetails[]> {
  const { rows: orders } = await db.query<Order>(
    "select * from orders order by created_at desc limit $1 offset $2",
    [pageSize, (page - 1) * pageSize],
  );

  const result: OrderWithDetails[] = [];
  for (const order of orders) {
    const { rows: items } = await db.query("select * from order_items where order_id = $1 order by id", [order.id]);
    const {
      rows: [customer],
    } = await db.query("select id, name, email from customers where id = $1", [order.customer_id]);
    const {
      rows: [shippingAddress],
    } = await db.query("select * from addresses where id = $1", [order.shipping_address_id]);
    result.push({ ...order, items, customer, shippingAddress });
  }
  return result;
}

export async function getOrder(db: Db, id: string): Promise<OrderWithDetails | null> {
  const [order] = await listOrdersByIds(db, [id]);
  return order ?? null;
}

async function listOrdersByIds(db: Db, ids: string[]): Promise<OrderWithDetails[]> {
  const { rows } = await db.query<OrderWithDetails>("select * from orders_with_details where id = any($1)", [ids]);
  return rows;
}
`;

export const SHOP_REPO_AFTER = `import type { Db } from "../db/index.js";
import type { OrderWithDetails } from "./types.js";

/**
 * One page of orders with their customer, shipping address and items, in a single query.
 * (It used to be 1 + 3 per order: 301 queries for a page of 100.)
 */
export async function listOrders(db: Db, { page = 1, pageSize = 100 } = {}): Promise<OrderWithDetails[]> {
  const { rows } = await db.query<OrderWithDetails>(
    \`select o.*,
            json_build_object('id', c.id, 'name', c.name, 'email', c.email) as customer,
            to_json(a) as "shippingAddress",
            coalesce(json_agg(i order by i.id) filter (where i.id is not null), '[]') as items
       from orders o
       join customers c on c.id = o.customer_id
       left join addresses a on a.id = o.shipping_address_id
       left join order_items i on i.order_id = o.id
      group by o.id, c.id, a.id
      order by o.created_at desc
      limit $1 offset $2\`,
    [pageSize, (page - 1) * pageSize],
  );
  return rows;
}

export async function getOrder(db: Db, id: string): Promise<OrderWithDetails | null> {
  const [order] = await listOrdersByIds(db, [id]);
  return order ?? null;
}

async function listOrdersByIds(db: Db, ids: string[]): Promise<OrderWithDetails[]> {
  const { rows } = await db.query<OrderWithDetails>("select * from orders_with_details where id = any($1)", [ids]);
  return rows;
}
`;

export const SHOP_SERVER_BEFORE = `import express from "express";
import { db } from "./db/index.js";
import { orderRoutes } from "./orders/routes.js";

const app = express();
app.use(express.json());
app.use("/admin/orders", orderRoutes(db));

app.listen(4100, () => console.log("shop admin on http://localhost:4100/admin"));
`;

export const SHOP_SERVER_AFTER = `import express from "express";
import { db } from "./db/index.js";
import { orderRoutes } from "./orders/routes.js";

const app = express();
app.use(express.json());

// For the load balancer: 200 when the database answers, 503 when it doesn't.
app.get("/healthz", async (_req, res) => {
  try {
    await db.query("select 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use("/admin/orders", orderRoutes(db));

app.listen(4100, () => console.log("shop admin on http://localhost:4100/admin"));
`;

export const SHOP_TEST_BEFORE = `import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "./app.js";

describe("GET /admin/orders", () => {
  it("returns a page of orders with items and customers", async () => {
    const res = await request(app).get("/admin/orders");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(100);
    expect(res.body[0].customer.email).toMatch(/@/);
    expect(Array.isArray(res.body[0].items)).toBe(true);
  });
});
`;

const SHOP_FILES: Record<string, string> = {
  "README.md": `# shop

Back office for Acme: orders, refunds, inventory. Express + Postgres.

\`\`\`bash
npm run dev            # http://localhost:4100/admin
npm test
npm run query-log -- /admin/orders   # count the SQL a request runs
\`\`\`
`,
  "package.json": `{
  "name": "shop",
  "version": "1.12.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "test": "vitest run",
    "query-log": "tsx scripts/query-log.ts"
  },
  "dependencies": {
    "express": "^5.1.0",
    "pg": "^8.16.3"
  },
  "devDependencies": {
    "@types/express": "^5.0.3",
    "@types/pg": "^8.15.5",
    "supertest": "^7.1.4",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
`,
  "src/server.ts": SHOP_SERVER_AFTER,
  "src/db/index.ts": `import pg from "pg";

export type Db = pg.Pool;

export const db: Db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

/** Every statement, for scripts/query-log.ts. */
export function onQuery(listener: (sql: string, ms: number) => void) {
  const query = db.query.bind(db);
  db.query = (async (...args: Parameters<typeof query>) => {
    const t = performance.now();
    try {
      return await query(...args);
    } finally {
      listener(String(args[0]), performance.now() - t);
    }
  }) as typeof db.query;
}
`,
  "src/orders/types.ts": `export interface Order {
  id: string;
  status: "pending" | "paid" | "shipped" | "refunded";
  total_cents: number;
  customer_id: string;
  shipping_address_id: string | null;
  created_at: string;
}

export interface OrderWithDetails extends Order {
  customer: { id: string; name: string; email: string };
  shippingAddress: Record<string, unknown> | null;
  items: { id: string; sku: string; quantity: number; price_cents: number }[];
}
`,
  "src/orders/routes.ts": `import { Router } from "express";
import type { Db } from "../db/index.js";
import { getOrder, listOrders } from "./repo.js";

export function orderRoutes(db: Db) {
  const r = Router();
  r.get("/", async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    res.json(await listOrders(db, { page }));
  });
  r.get("/:id", async (req, res) => {
    const order = await getOrder(db, req.params.id);
    if (!order) return res.status(404).end();
    res.json(order);
  });
  return r;
}
`,
  "src/orders/repo.ts": SHOP_REPO_BEFORE,
  "scripts/query-log.ts": `import { onQuery } from "../src/db/index.js";

const path = process.argv[2] ?? "/admin/orders";
let count = 0;
let total = 0;
onQuery((_sql, ms) => {
  count++;
  total += ms;
});

await import("../src/server.js");
const t = performance.now();
await fetch(\`http://localhost:4100\${path}\`);
console.log(\`GET \${path}: \${count} queries, \${total.toFixed(0)} ms in SQL, \${(performance.now() - t).toFixed(0)} ms total\`);
process.exit(0);
`,
  "test/orders.test.ts": SHOP_TEST_BEFORE,
};

// ---------------------------------------------------------------------------
// docs
// ---------------------------------------------------------------------------

export const DOCS_RELEASE_24 = `# Acme 2.4

_Released October 2026_

## Checkout
- Your cart survives signing in halfway through checkout. (#408)
- Product images are served as AVIF where the browser supports it, about 40% smaller. (#401)

## Back office
- **Partial refunds.** Refund individual line items instead of the whole order. (#406)
- CSV export includes the shipping address. (#402)
- Search finds order numbers with or without the \`#\`. (#395)

## Security
- **Signed webhooks, v2.** Payloads are signed with HMAC-SHA256 in \`Acme-Signature: v2=…\`. v1 signatures are still sent until 2.6. (#404)
- Sessions expire after 7 days instead of 30. (#403)

## Fixes
- Two tabs could place the same order twice. (#399)
- \`GET /me\` returned \`500\` for a deleted user; it's \`401\` now. (#397)

## Under the hood
- Express 5, and CI runs on Node 22. (#393)

## Upgrading
Verify webhooks with the v2 signature (see [Getting started](../getting-started.md)); v1 goes away in 2.6.
`;

const DOCS_FILES: Record<string, string> = {
  "package.json": `{
  "name": "docs",
  "private": true,
  "scripts": {
    "dev": "vitepress dev docs",
    "build": "vitepress build docs"
  },
  "devDependencies": {
    "vitepress": "^2.0.0"
  }
}
`,
  "CHANGELOG.md": `# Changelog

## 2.3.0
- Order webhooks retry with exponential backoff (#377)
- Saved addresses at checkout (#372)
- Admin search by order number or email (#369)

## 2.2.0
- Dark mode for the back office (#351)
- Inventory alerts by email (#344)
`,
  "docs/index.md": `# Acme developer docs

- [Getting started](./getting-started.md)
- [Rate limits](./guides/rate-limits.md)
- Release notes: [2.4](./releases/2.4.md) · [2.3](./releases/2.3.md)
`,
  "docs/getting-started.md": `# Getting started

1. Create an API key in **Settings → Developers**.
2. Call the API with \`Authorization: Bearer <key>\`.
3. Webhooks are signed with your endpoint secret; verify the \`Acme-Signature\` header.
`,
  "docs/guides/rate-limits.md": `# Rate limits

| Endpoint | Limit |
| --- | --- |
| \`POST /login\` | 5 per 15 minutes per IP + email |
| Everything else | 600 per minute per key |

Limited requests get \`429 Too Many Requests\` with a \`Retry-After\` header in seconds.
`,
  "docs/releases/2.3.md": `# Acme 2.3

_Released August 2026_

## Orders
- Webhooks retry with exponential backoff, up to 24 hours. (#377)
- Admin search by order number or customer email. (#369)

## Checkout
- Saved addresses. (#372)
`,
  "docs/releases/2.4.md": DOCS_RELEASE_24,
  ".vitepress/config.ts": `import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Acme docs",
  cleanUrls: true,
  themeConfig: {
    nav: [{ text: "Guides", link: "/guides/rate-limits" }, { text: "Releases", link: "/releases/2.4" }],
  },
});
`,
};

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

export const AUTH_ROUTES_BEFORE = `import { Router } from "express";
import { passwordSignIn } from "./password.js";

export const routes = Router();

routes.post("/sign-in/password", passwordSignIn);
`;

export const AUTH_ROUTES_AFTER = `import { Router } from "express";
import { passwordSignIn } from "./password.js";
import { finishRegistration, finishSignIn, startRegistration, startSignIn } from "./passkeys.js";
import { requireUser } from "./session.js";

export const routes = Router();

routes.post("/sign-in/password", passwordSignIn);

// Passkeys sit beside passwords: register one while signed in, then use it to sign in.
routes.post("/passkeys/register/options", requireUser, async (req, res) => res.json(await startRegistration(req.user!)));
routes.post("/passkeys/register", requireUser, async (req, res) => res.json(await finishRegistration(req.user!.id, req.body)));
routes.post("/sign-in/passkey/options", async (_req, res) => res.json(await startSignIn()));
routes.post("/sign-in/passkey", async (req, res) => {
  const user = await finishSignIn(req.body);
  if (!user) return res.status(401).json({ error: "passkey_rejected" });
  res.json(user);
});
`;

export const AUTH_PASSKEYS = `import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { challenges, credentials, users } from "./store.js";

const rpName = "Acme";
const rpID = process.env.RP_ID ?? "localhost";
const origin = process.env.ORIGIN ?? \`http://\${rpID}:3000\`;

export async function startRegistration(user: { id: string; email: string }) {
  const existing = await credentials.forUser(user.id);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  await challenges.set(user.id, options.challenge);
  return options;
}

export async function finishRegistration(userId: string, response: RegistrationResponseJSON) {
  const expectedChallenge = await challenges.take(userId);
  if (!expectedChallenge) throw new Error("No registration in progress");
  const { verified, registrationInfo } = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID });
  if (!verified || !registrationInfo) return { verified: false };
  const { credential } = registrationInfo;
  await credentials.add({ id: credential.id, userId, publicKey: credential.publicKey, counter: credential.counter, transports: response.response.transports ?? [] });
  return { verified: true };
}

export async function startSignIn() {
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
  await challenges.set(\`signin:\${options.challenge}\`, options.challenge);
  return options;
}

export async function finishSignIn(response: AuthenticationResponseJSON) {
  const credential = await credentials.get(response.id);
  if (!credential) return null;
  const challenge = JSON.parse(atob(response.response.clientDataJSON)).challenge as string;
  const expectedChallenge = await challenges.take(\`signin:\${challenge}\`);
  if (!expectedChallenge) return null;
  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: { id: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports },
  });
  if (!verified) return null;
  await credentials.bump(credential.id, authenticationInfo.newCounter);
  return users.get(credential.userId);
}
`;

export const AUTH_PASSKEYS_TEST = `import { describe, expect, it } from "vitest";
import { startRegistration, startSignIn } from "../src/passkeys.js";

describe("passkeys", () => {
  it("offers registration options for a signed-in user", async () => {
    const options = await startRegistration({ id: "u_1", email: "ada@example.com" });
    expect(options.rp.name).toBe("Acme");
    expect(options.user.name).toBe("ada@example.com");
    expect(options.challenge).toBeTruthy();
  });

  it("offers sign-in options without a user", async () => {
    const options = await startSignIn();
    expect(options.rpId).toBe("localhost");
    expect(options.allowCredentials ?? []).toHaveLength(0);
  });
});
`;

export const AUTH_VITEST_SETUP = `import { webcrypto } from "node:crypto";

// jsdom has no WebCrypto; @simplewebauthn/server needs crypto.subtle.
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
`;

export const AUTH_VITEST_BEFORE = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
  },
});
`;

export const AUTH_VITEST_AFTER = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
});
`;

const AUTH_FILES: Record<string, string> = {
  "package.json": `{
  "name": "auth",
  "version": "0.9.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@simplewebauthn/server": "^13.1.2",
    "express": "^5.1.0"
  },
  "devDependencies": {
    "jsdom": "^26.1.0",
    "tsx": "^4.20.5",
    "typescript": "^5.9.2",
    "vitest": "^3.2.4"
  }
}
`,
  "docs/webauthn.md": `# WebAuthn notes

- Relying party ID is the bare domain (\`acme.shop\`), origin includes the scheme.
- Ask for \`residentKey: "preferred"\` so passkeys can sign in without a username.
- Store the credential id, public key, counter and transports. Reject a counter that goes backwards.
- Keep passwords: passkeys are added from account settings and offered on the sign-in page.
`,
  "src/index.ts": `import express from "express";
import { routes } from "./routes.js";

const app = express();
app.use(express.json());
app.use("/auth", routes);
app.listen(4200, () => console.log("auth on http://localhost:4200"));
`,
  "src/password.ts": `import type { RequestHandler } from "express";
import { users } from "./store.js";

export const passwordSignIn: RequestHandler = async (req, res) => {
  const user = await users.verifyPassword(req.body.email, req.body.password);
  if (!user) return res.status(401).json({ error: "invalid_credentials" });
  res.json(user);
};
`,
  "src/session.ts": `import type { RequestHandler } from "express";

declare module "express-serve-static-core" {
  interface Request {
    user?: { id: string; email: string };
  }
}

export const requireUser: RequestHandler = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "unauthenticated" });
  next();
};
`,
  "src/store.ts": `type Credential = { id: string; userId: string; publicKey: Uint8Array; counter: number; transports: string[] };

const creds = new Map<string, Credential>();
const pending = new Map<string, string>();

export const credentials = {
  async forUser(userId: string) {
    return [...creds.values()].filter((c) => c.userId === userId);
  },
  async get(id: string) {
    return creds.get(id) ?? null;
  },
  async add(c: Credential) {
    creds.set(c.id, c);
  },
  async bump(id: string, counter: number) {
    const c = creds.get(id);
    if (c) c.counter = counter;
  },
};

export const challenges = {
  async set(key: string, challenge: string) {
    pending.set(key, challenge);
  },
  async take(key: string) {
    const c = pending.get(key) ?? null;
    pending.delete(key);
    return c;
  },
};

export const users = {
  async get(id: string) {
    return { id, email: \`\${id}@example.com\` };
  },
  async verifyPassword(email: string, password: string) {
    return password ? { id: "u_1", email } : null;
  },
};
`,
  "src/routes.ts": AUTH_ROUTES_AFTER,
  "src/passkeys.ts": AUTH_PASSKEYS,
  "test/passkeys.test.ts": AUTH_PASSKEYS_TEST,
  "vitest.config.ts": AUTH_VITEST_BEFORE,
};

/** Puts the demo machine's files in place. */
export function seedFiles(fs: DemoFs) {
  const put = (root: string, files: Record<string, string>) => {
    fs.mkdirp(root);
    for (const [rel, text] of Object.entries(files)) fs.write(`${root}/${rel}`, text);
  };
  const deps = (root: string, names: string[]) => names.forEach((n) => fs.mkdirp(`${root}/node_modules/${n}`));
  fs.mkdirp(`${HOME}/Documents`);
  fs.mkdirp(`${HOME}/Downloads`);

  // api, as of the fork point; the worktree branches from here.
  put(P.api, API_FILES);
  deps(P.api, ["argon2", "express", "jose", "pg", "vitest", "zod"]);
  fs.copyTree(P.api, REDIS_WT.path);
  // ...then each side's own changes.
  fs.write(`${P.api}/src/server/rateLimit.ts`, API_RATE_LIMIT);
  fs.write(`${P.api}/src/server/auth.ts`, API_AUTH_AFTER);
  fs.write(`${P.api}/test/auth.test.ts`, API_AUTH_TEST_AFTER);
  fs.write(`${P.api}/test/rateLimit.test.ts`, API_RATE_LIMIT_TEST);
  fs.write(`${REDIS_WT.path}/src/server/rateLimit.ts`, API_RATE_LIMIT_REDIS);
  fs.write(`${REDIS_WT.path}/src/server/store/redis.ts`, API_REDIS_STORE);
  fs.write(`${REDIS_WT.path}/src/server/auth.ts`, API_AUTH_REDIS);
  fs.write(`${REDIS_WT.path}/package.json`, API_PACKAGE(true));

  put(P.web, WEB_FILES);
  deps(P.web, ["react", "react-dom", "react-router", "typescript", "webpack", "vitest"]);
  put(P.shop, SHOP_FILES);
  deps(P.shop, ["express", "pg", "tsx", "vitest"]);
  put(P.docs, DOCS_FILES);
  deps(P.docs, ["vitepress"]);
  put(P.auth, AUTH_FILES);
  deps(P.auth, ["@simplewebauthn", "express", "jsdom", "vitest"]);
}

export const API_PACKAGE_BASE = API_PACKAGE(false);
export const API_PACKAGE_REDIS = API_PACKAGE(true);

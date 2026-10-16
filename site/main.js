(() => {
  "use strict";

  const REPO = "ItsJustMeChris/ret";
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ nav */
  const nav = $("#nav");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ------------------------------------------------------------------ platform */
  const ua = navigator.userAgent;
  const uaPlatform = (navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  const isMobile = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(ua);
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isMac = !isMobile && (/mac/.test(uaPlatform) || /Mac OS X/.test(ua));
  const isWin = !isMobile && (/win/.test(uaPlatform) || /Windows/.test(ua));
  const os = isMac ? "mac" : isWin ? "win" : null;
  let macArch = "arm64";

  if (isMac) {
    $$("[data-mod]").forEach((el) => (el.textContent = "⌘"));
    $$("[data-alt]").forEach((el) => (el.textContent = "⌥"));
    $$("[data-mod-sym]").forEach((el) => (el.textContent = "⌘"));
  }

  /* ------------------------------------------------------------------ downloads */
  // Links start at the releases page; the GitHub API upgrades them to the exact files.
  const assets = { win: null, "mac-arm64": null, "mac-x64": null };
  let release = null;
  const mb = (bytes) => `· ${Math.round(bytes / 1048576)} MB`;
  const mineKey = () => (os === "win" ? "win" : os === "mac" ? `mac-${macArch}` : isIOS ? "ios" : null);

  function applyDownloads() {
    const mine = mineKey();
    $$(".dl-card").forEach((c) => c.classList.toggle("mine", c.dataset.dl === mine));
    for (const [key, a] of Object.entries(assets)) {
      if (!a) continue;
      $$(`[data-dl="${key}"]`).forEach((el) => (el.href = a.url));
      $$(`[data-size="${key}"]`).forEach((el) => (el.textContent = mb(a.size)));
    }
    const label = os === "win" ? "Download for Windows" : os === "mac" ? "Download for macOS" : "Download Ret";
    $$("[data-dl-label]").forEach((el) => (el.textContent = label));
    $$("[data-dl-primary]").forEach((el) => (el.href = mine && assets[mine] ? assets[mine].url : "#download"));
    if (release) {
      const v = release.tag.replace(/^v/, "");
      const date = new Date(release.at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      $$("[data-version-line]").forEach((el) => (el.textContent = `Version ${v} for Windows & macOS`));
      $$("[data-version-foot]").forEach((el) => (el.textContent = `Version ${v}, released ${date}`));
    }
  }

  async function loadRelease() {
    let data = null;
    try {
      data = JSON.parse(sessionStorage.getItem("ret-release") || "null");
    } catch {}
    if (!data) {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const j = await res.json();
      data = { tag: j.tag_name, at: j.published_at, assets: j.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })) };
      try {
        sessionStorage.setItem("ret-release", JSON.stringify(data));
      } catch {}
    }
    const find = (re) => data.assets.find((a) => re.test(a.name)) || null;
    assets.win = find(/^Ret-Setup-.*\.exe$/i);
    assets["mac-arm64"] = find(/-arm64\.dmg$/i);
    assets["mac-x64"] = find(/-x64\.dmg$/i);
    release = data;
    applyDownloads();
  }

  applyDownloads();
  loadRelease().catch(() => {});
  if (isMac && navigator.userAgentData?.getHighEntropyValues) {
    navigator.userAgentData
      .getHighEntropyValues(["architecture"])
      .then((v) => {
        if (v.architecture === "x86") {
          macArch = "x64";
          applyDownloads();
        }
      })
      .catch(() => {});
  }

  /* ------------------------------------------------------------------ scaled stages */
  const scaleOf = (stage) => Number(getComputedStyle(stage).getPropertyValue("--s")) || 1;
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const el = e.target;
      const cs = getComputedStyle(el);
      const w = Number(cs.getPropertyValue("--w"));
      // --vw < --w crops the design to its left part instead of shrinking all of it.
      const vw = Number(cs.getPropertyValue("--vw")) || w;
      if (!w) continue;
      el.classList.toggle("cropped", vw < w);
      el.style.setProperty("--s", (el.clientWidth / vw).toFixed(4));
    }
  });
  $$(".stage").forEach((s) => ro.observe(s));

  /* ------------------------------------------------------------------ reveal */
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px" },
  );
  $$(".reveal").forEach((el) => io.observe(el));

  /* ------------------------------------------------------------------ hero tilt */
  const heroStage = $("#hero-stage");
  let engaged = false;
  function tilt() {
    if (reduced || engaged) {
      heroStage.style.transform = "none";
      return;
    }
    const r = heroStage.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (r.top - innerHeight * 0.22) / (innerHeight * 0.6)));
    heroStage.style.transform = t > 0.002 ? `rotateX(${(t * 16).toFixed(2)}deg) scale(${(1 - t * 0.04).toFixed(4)})` : "none";
  }
  addEventListener("scroll", tilt, { passive: true });
  addEventListener("resize", tilt);
  tilt();

  /* ------------------------------------------------------------------ helpers for the mocks */
  const svgUse = (id, cls = "") => `<svg class="i ${cls}"><use href="#${id}" /></svg>`;
  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function stepHtml(icon, text, extra = "", state = "spin") {
    const tail = state === "spin" ? '<span class="spin"></span>' : state === "no" ? svgUse("i-x", "no") : svgUse("i-check", "ok");
    return `<div class="m-step m-new">${svgUse(icon)}<span>${text}</span>${extra}${tail}</div>`;
  }
  function finishStep(step) {
    step.querySelector(".spin")?.replaceWith(el(svgUse("i-check", "ok")));
  }
  /** Types `html`'s text into `node`, then swaps in the formatted version. */
  async function typeInto(node, html, cps, sleep) {
    const text = el(`<div>${html}</div>`).textContent;
    node.classList.add("typing");
    node.textContent = "";
    const step = Math.max(1, Math.round(cps / 30));
    for (let i = 0; i < text.length; i += step) {
      node.textContent = text.slice(0, i + step);
      await sleep(1000 / 30);
    }
    node.innerHTML = html;
    node.classList.remove("typing");
  }
  /** Offset of `node` inside `ancestor`, from layout (ignores CSS transforms). */
  function offsetIn(node, ancestor) {
    let x = 0;
    let y = 0;
    while (node && node !== ancestor) {
      x += node.offsetLeft;
      y += node.offsetTop;
      node = node.offsetParent;
    }
    return { x, y };
  }

  /* ------------------------------------------------------------------ hero mock */
  const heroMock = $("#hero-mock");
  const H = (name) => heroMock.querySelector(`[data-h="${name}"]`);
  let heroVisible = true;
  let liveReady = false;
  new IntersectionObserver(([e]) => (heroVisible = e.isIntersecting)).observe(heroStage);
  const heroActive = () => heroVisible && !liveReady && !document.hidden;

  /** Sleeps for `ms` of time the hero is actually on screen. */
  function heroSleep(ms) {
    return new Promise((resolve) => {
      let left = ms;
      let last = performance.now();
      const tick = (now) => {
        if (heroActive()) left -= now - last;
        last = now;
        if (left <= 0) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  function setNeeds(n, working) {
    H("need-count").textContent = String(n);
    H("need-pill").textContent = `${n} need${n === 1 ? "s" : ""} you`;
    H("work-pill").textContent = `${working} working`;
  }
  function setW1(state) {
    H("w1-dot").className = `dot ${state}`;
    H("mm-w1").className = state;
    H("w1").classList.toggle("ask", state === "attention");
  }

  const w1Text = H("w1-text").innerHTML;
  const w2Text = H("w2-text").innerHTML;
  const w3Text = H("w3-text").innerHTML;

  function heroReset() {
    $$(".m-dyn", heroMock).forEach((n) => n.remove());
    H("w1-card").hidden = true;
    H("w1-card").classList.remove("m-out");
    H("w1-allow").classList.remove("pressed");
    H("w1-text").innerHTML = w1Text;
    H("w2-text").innerHTML = w2Text;
    H("w3-text").innerHTML = w3Text;
    setW1("running");
    setNeeds(1, 3);
  }

  async function heroW1(sleep) {
    const body = heroMock.querySelector(".m-body");
    const tx = H("w1-tx");
    const cursor = H("cursor");
    const s = sleep;
    await typeInto(H("w1-text"), w1Text, 62, s);
    await s(500);
    const card = H("w1-card");
    card.hidden = false;
    card.classList.add("m-new");
    setW1("attention");
    setNeeds(2, 2);
    await s(1100);

    // The cursor drifts in and clicks "Allow once".
    const btn = H("w1-allow");
    const target = offsetIn(btn, body);
    cursor.style.transition = "none";
    cursor.style.transform = `translate(${target.x + 260}px, ${target.y + 150}px)`;
    cursor.getBoundingClientRect();
    cursor.style.transition = "transform 1.1s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.3s";
    cursor.classList.add("on");
    cursor.style.transform = `translate(${target.x + 30}px, ${target.y + 12}px)`;
    await s(1300);
    cursor.classList.add("click");
    btn.classList.add("pressed");
    await s(260);
    card.classList.add("m-out");
    await s(280);
    card.hidden = true;
    cursor.classList.remove("on", "click");

    const step = el(stepHtml("i-term", "Ran <code>npm test -- auth</code>"));
    step.classList.add("m-dyn");
    tx.append(step);
    setW1("running");
    setNeeds(1, 3);
    await s(1700);
    finishStep(step);
    await s(350);
    const reply = el('<div class="m-text m-new m-dyn"></div>');
    tx.append(reply);
    await typeInto(reply, "All 42 auth tests pass. Over the limit, <code>/login</code> now answers <code>429</code> until the window resets.", 62, s);
    setW1("unread");
    setNeeds(1, 2);
    await s(4200);
  }

  async function heroW3(sleep) {
    await sleep(2600);
    const tx = H("w3-tx");
    const step = el(stepHtml("i-term", "Ran <code>npm run dev</code>"));
    step.classList.add("m-dyn");
    tx.append(step);
    await sleep(1900);
    finishStep(step);
    await sleep(300);
    const t = el('<div class="m-text m-new m-dyn"></div>');
    tx.append(t);
    await typeInto(t, "HMR works. Deleting <code>webpack.config.js</code> and the loaders we no longer need.", 55, sleep);
    await sleep(600);
    const del = el(stepHtml("i-filepen", "Edited package.json", '<span class="add">+3</span><span class="del">−11</span>'));
    del.classList.add("m-dyn");
    tx.append(del);
    await sleep(1200);
    finishStep(del);
  }

  async function heroW2(sleep) {
    await sleep(5200);
    const tx = H("w2-tx");
    const step = el(stepHtml("i-term", "Ran <code>docker compose up -d redis</code>"));
    step.classList.add("m-dyn");
    tx.append(step);
    await sleep(2000);
    finishStep(step);
    await sleep(300);
    const t = el('<div class="m-text m-new m-dyn"></div>');
    tx.append(t);
    await typeInto(t, "Redis is up. Running the suite against it.", 55, sleep);
  }

  async function heroLoop() {
    if (reduced) {
      H("w1-card").hidden = false;
      setW1("attention");
      setNeeds(2, 2);
      return;
    }
    await heroSleep(700);
    for (;;) {
      if (liveReady) return;
      heroReset();
      await Promise.all([heroW1(heroSleep), heroW2(heroSleep), heroW3(heroSleep)]);
    }
  }
  heroLoop();

  /* ------------------------------------------------------------------ live demo */
  // On big screens the hero swaps its redraw for the real renderer, built into /demo/ from
  // src/renderer with an in-browser engine. It stays inert until clicked so the page scrolls.
  const live = $("#live");
  const frame = $("#live-frame");
  const gate = $("#live-gate");
  const exit = $("#live-exit");
  const canLive = () => innerWidth >= 960 && !isMobile && !navigator.connection?.saveData;

  function engage() {
    if (!liveReady) return;
    engaged = true;
    live.classList.add("active");
    exit.hidden = false;
    tilt();
    frame.focus({ preventScroll: true });
  }
  function disengage() {
    if (!engaged) return;
    engaged = false;
    live.classList.remove("active");
    exit.hidden = true;
    tilt();
  }
  gate.addEventListener("click", engage);
  exit.addEventListener("click", disengage);
  document.addEventListener("pointerdown", (e) => {
    if (engaged && !live.contains(e.target)) disengage();
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") disengage();
  });
  new IntersectionObserver(([e]) => e.intersectionRatio < 0.35 && disengage(), { threshold: [0, 0.35, 1] }).observe(heroStage);

  addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow || e.origin !== location.origin) return;
    if (e.data?.type === "ret-demo:ready" && !liveReady) {
      liveReady = true;
      live.classList.add("ready");
      heroStage.classList.add("has-live");
      document.documentElement.classList.add("has-live");
    }
  });

  function startLive() {
    if (!canLive()) {
      $("#hero-note").hidden = innerWidth >= 960;
      return;
    }
    // Only deployments that built the demo have it; the others keep the redraw.
    fetch("demo/", { method: "HEAD" })
      .then((res) => {
        if (!res.ok) return;
        live.hidden = false;
        frame.src = "demo/?embed=1";
        setTimeout(() => {
          if (!liveReady) {
            live.hidden = true;
            frame.removeAttribute("src");
          }
        }, 20000);
      })
      .catch(() => {});
  }
  const whenIdle = (fn) => ("requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 600));
  if (document.readyState === "complete") whenIdle(startLive);
  else addEventListener("load", () => whenIdle(startLive));

  $$("[data-try]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!liveReady) return;
      frame.contentWindow.postMessage({ type: "ret-demo:mode", mode: b.dataset.try }, location.origin);
      heroStage.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
      // Hand the demo the pointer once the page has arrived (scrollend doesn't fire if it was already there).
      let done = false;
      const arrive = () => {
        if (done) return;
        done = true;
        engage();
      };
      addEventListener("scrollend", arrive, { once: true });
      setTimeout(arrive, reduced ? 0 : 1200);
    }),
  );

  /* ------------------------------------------------------------------ approvals demo */
  {
    const tx = $("#ap-tx");
    const q = $("#ap-q");
    const dot = $("#ap-dot");
    const replay = $("#ap-replay");
    const ph = $("#ap-ph");
    const initial = tx.innerHTML;
    const opts = $$(".m-opt", q);
    let hl = 1;
    let busy = false;
    let inView = false;
    const sleep = (ms) => wait(reduced ? 0 : ms);
    new IntersectionObserver(([e]) => (inView = e.isIntersecting), { threshold: 0.4 }).observe($("#approve-stage"));

    const setDot = (s) => (dot.className = `dot ${s}`);
    const highlight = (i) => {
      hl = i;
      opts.forEach((o, j) => o.classList.toggle("hl", j === i));
    };
    const say = async (html) => {
      const t = el('<div class="m-text m-new"></div>');
      tx.append(t);
      await typeInto(t, html, 70, sleep);
    };
    const run = async (icon, text, extra) => {
      const st = el(stepHtml(icon, text, extra));
      tx.append(st);
      await sleep(1300);
      finishStep(st);
    };

    function bindReset() {
      $$("[data-ap]", tx).forEach((b) => b.addEventListener("click", () => approve(b.dataset.ap, b)));
    }
    bindReset();

    async function approve(kind, btn) {
      if (busy) return;
      busy = true;
      btn.classList.add("pressed");
      await sleep(180);
      const card = $("#ap-card");
      card.classList.add("m-out");
      await sleep(280);
      card.remove();
      if (kind === "decline") {
        tx.append(el(stepHtml("i-term", "Declined <code>npm test -- auth</code>", "", "no")));
        setDot("running");
        await sleep(500);
        await say("No problem, I'll leave the test run to you. One decision before I wire up storage:");
      } else {
        setDot("running");
        await run("i-term", "Ran <code>npm test -- auth</code>");
        await sleep(250);
        await say(`All 42 auth tests pass${kind === "session" ? ", and I won't ask about test runs again this session" : ""}. One decision before I wire up storage:`);
      }
      await sleep(300);
      q.hidden = false;
      q.classList.remove("m-new");
      q.offsetWidth;
      q.classList.add("m-new");
      setDot("attention");
      highlight(1);
      busy = false;
    }

    async function answer(i) {
      if (busy || q.hidden) return;
      busy = true;
      highlight(i);
      await sleep(220);
      q.hidden = true;
      setDot("running");
      if (i === -1) {
        await say("Going with Redis, since production runs more than one instance.");
      } else {
        const said = ["In memory", "Redis, shared across instances", "Use the Postgres we already have."][i];
        tx.append(el(`<div class="m-user m-new">${said}</div>`));
        await sleep(500);
      }
      if (i === 0) {
        await say("Keeping it in memory, with a note that limits apply per instance.");
        await run("i-filepen", "Edited src/server/rateLimit.ts", '<span class="add">+6</span><span class="del">−1</span>');
        await say("Done. Tests still pass.");
      } else if (i === 2) {
        await say("Good call. Adding a <code>login_attempts</code> table with a cleanup job.");
        await run("i-filepen", "Created migrations/0042_login_attempts.sql", '<span class="add">+18</span>');
        await say("Done. Counters live in Postgres, so every instance sees the same limits.");
      } else {
        if (i === 1) await say("On it, wiring up the Redis store.");
        await run("i-filepen", "Edited src/server/store/redis.ts", '<span class="add">+31</span><span class="del">−4</span>');
        await say("Done. Counters live in Redis with a 60-second expiry, so every instance shares them.");
      }
      setDot("unread");
      replay.hidden = false;
      busy = false;
    }

    opts.forEach((o, i) => o.addEventListener("click", () => answer(i)));
    opts.forEach((o, i) => o.addEventListener("pointerenter", () => highlight(i)));
    $(".sk", q).style.cursor = "pointer";
    $(".sk", q).addEventListener("click", () => answer(-1));

    addEventListener("keydown", (e) => {
      if (q.hidden || busy || !inView || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
      if (/^[1-3]$/.test(e.key)) {
        e.preventDefault();
        answer(Number(e.key) - 1);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        highlight((hl + (e.key === "ArrowDown" ? 1 : 2)) % 3);
      } else if (e.key === "Enter") {
        e.preventDefault();
        answer(hl);
      }
    });

    replay.addEventListener("click", () => {
      tx.innerHTML = initial;
      q.hidden = true;
      replay.hidden = true;
      setDot("attention");
      ph.textContent = "Ask for follow-up changes";
      bindReset();
    });
  }

  /* ------------------------------------------------------------------ turn rail */
  {
    const art = $("#rail-art");
    const rail = $("#rail");
    const tip = $("#rail-tip");
    const turns = [
      "Add rate limiting to /login",
      "Keep the tests green",
      "Why 429 and not 403?",
      "Add a Retry-After header",
      "Try a Redis store",
      "Run the auth tests",
      "Make the window configurable",
      "Log blocked attempts",
      "Write the changelog entry",
      "Clean up the old middleware",
    ];
    const N = 36;
    const ticks = Array.from({ length: N }, () => rail.appendChild(document.createElement("i")));
    let hovering = false;
    let centers = [];
    const measure = () => (centers = ticks.map((t) => t.offsetLeft + t.offsetWidth / 2));

    function lens(x) {
      if (!centers.length) measure();
      let best = 0;
      ticks.forEach((t, i) => {
        const d = Math.abs(centers[i] - x);
        const k = Math.exp(-((d / 34) ** 2));
        t.style.height = `${18 + 36 * k}px`;
        t.style.margin = `0 ${2.5 + 4 * k}px`;
        if (k > Math.exp(-((Math.abs(centers[best] - x) / 34) ** 2))) best = i;
      });
      ticks.forEach((t, i) => t.classList.toggle("me", i === best));
      return best;
    }
    function relax() {
      ticks.forEach((t) => {
        t.style.height = "";
        t.style.margin = "";
        t.classList.remove("me");
      });
    }
    art.addEventListener("pointermove", (e) => {
      hovering = true;
      const r = rail.getBoundingClientRect();
      const i = lens(e.clientX - r.left);
      tip.innerHTML = `Turn ${i + 1} · <b>${turns[i % turns.length]}</b>`;
    });
    art.addEventListener("pointerleave", () => {
      hovering = false;
      relax();
      tip.textContent = "Point at the rail";
    });
    addEventListener("resize", () => (centers = []));

    // While nobody's pointing, a slow sweep hints that it reacts.
    if (!reduced) {
      let visible = false;
      new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(art);
      const sweep = (now) => {
        if (visible && !hovering) {
          measure();
          const w = rail.offsetWidth;
          lens(w / 2 + Math.sin(now / 1400) * w * 0.42);
        }
        requestAnimationFrame(sweep);
      };
      requestAnimationFrame(sweep);
    }
  }

  /* ------------------------------------------------------------------ mascot */
  {
    const m = $("#mascot");
    const pupils = $$(".pupil", m);
    const eyes = [
      { x: 452, y: 640 },
      { x: 802, y: 640 },
    ];
    let raf = 0;
    let px = 0;
    let py = 0;
    addEventListener(
      "pointermove",
      (e) => {
        px = e.clientX;
        py = e.clientY;
        if (!raf)
          raf = requestAnimationFrame(() => {
            raf = 0;
            const r = m.getBoundingClientRect();
            if (r.bottom < -200 || r.top > innerHeight + 200) return;
            const scale = r.width / 1250;
            pupils.forEach((p, i) => {
              const ex = r.left + eyes[i].x * scale;
              const ey = r.top + eyes[i].y * scale;
              const dx = px - ex;
              const dy = py - ey;
              const d = Math.hypot(dx, dy) || 1;
              const k = Math.min(1, d / 260);
              p.style.transform = `translate(${((dx / d) * 28 * k).toFixed(1)}px, ${((dy / d) * 24 * k).toFixed(1)}px)`;
            });
          });
      },
      { passive: true },
    );
    if (!reduced) {
      const blink = () => {
        m.classList.add("blink");
        setTimeout(() => m.classList.remove("blink"), 130);
        setTimeout(blink, 2600 + Math.random() * 3600);
      };
      setTimeout(blink, 2000);
    }
  }

  /* ------------------------------------------------------------------ tour */
  {
    const section = $("#tour");
    const box = $("#tour-box");
    const video = $("#tour-video");
    const src = video.dataset.src;
    // Fetch only the video's header once the section is near, and drop the section if it fails.
    const hide = () => (section.hidden = true);
    video.addEventListener("error", hide);
    if (!src) hide();
    else {
      const near = new IntersectionObserver(
        ([e]) => {
          if (!e.isIntersecting) return;
          near.disconnect();
          video.preload = "metadata";
          video.src = src;
        },
        { rootMargin: "800px 0px" },
      );
      near.observe(section);
    }
    $("#tour-play").addEventListener("click", () => {
      box.classList.add("playing");
      video.controls = true;
      if (!video.src) video.src = src;
      video.play().catch(() => {});
    });
    video.addEventListener("play", () => {
      box.classList.add("playing");
      video.controls = true;
    });
  }
})();

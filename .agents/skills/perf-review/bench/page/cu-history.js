// The first merge of ~800 steps of history (as hydrating does), measured: parse, then mergeTurns;
// then the same page again, as after an idle eviction (the step cache holds the last 500).
(async () => {
  const { AC, CU } = window.__ret;
  const N = window.__nav;
  const id = 'cuhist01-0000-4000-8000-000000000000';
  const t0 = performance.now();
  const page = JSON.parse(window.__cuPage);
  const t1 = performance.now();
  AC.mergeTurns(id, page, null, 'replace');
  const t2 = performance.now();
  await N.painted();
  const t3 = performance.now();
  const page2 = JSON.parse(window.__cuPage);
  const t4 = performance.now();
  AC.mergeTurns(id, page2, null, 'replace');
  const t5 = performance.now();
  await N.wait(1500);
  const sc = CU.useScreens.getState();
  const r = (v) => Math.round(v * 10) / 10;
  return { parseMs: r(t1 - t0), firstMergeMs: r(t2 - t1), toPaintMs: r(t3 - t2), secondMergeMs: r(t5 - t4), uses: Object.keys(sc.uses).length, shots: Object.keys(sc.shots).length };
})()

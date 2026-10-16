// The external poll's refresh of a thread running elsewhere: its last 3 turns, parsed and merged again every 3 s.
(async () => {
  const { AC } = window.__ret;
  const N = window.__nav;
  const id = 'cuwin001-0000-4000-8000-000000000000';
  const tail = JSON.stringify(JSON.parse(window.__cuPage).slice(0, 3)).split('cuhist01').join('cuwin001');
  const times = [];
  for (let k = 0; k < 6; k++) {
    const t0 = performance.now();
    const page = JSON.parse(tail);
    const t1 = performance.now();
    AC.mergeTurns(id, page, null, 'tail');
    const t2 = performance.now();
    await N.painted();
    times.push({ parse: Math.round((t1 - t0) * 10) / 10, merge: Math.round((t2 - t1) * 10) / 10, toPaint: Math.round(performance.now() - t2) });
    await N.wait(3000);
  }
  return { tailKB: Math.round(tail.length / 1024), times };
})()

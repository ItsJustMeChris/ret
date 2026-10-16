// What each screenshot costs to keep: the blob, its thumbnail, and one decode of the base64 on this thread.
(async () => {
  const { CU } = window.__ret;
  const shots = Object.values(CU.useScreens.getState().shots);
  const size = async (url) => (url ? (await (await fetch(url)).blob()).size : 0);
  const rows = [];
  for (const s of shots) rows.push([await size(s.url), await size(s.thumb)]);
  const kb = (v) => Math.round(v / 1024);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  // shotFrom's decode (atob + byte copy) for one screenshot, timed here.
  const b64 = window.__cuShots[0];
  const t0 = performance.now();
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const decodeMs = performance.now() - t0;
  const thumbs = rows.filter((r) => r[1]);
  return { kept: shots.length, blobKB: { avg: kb(avg(rows.map((r) => r[0]))), max: kb(Math.max(0, ...rows.map((r) => r[0]))) }, thumbKB: { count: thumbs.length, avg: kb(avg(thumbs.map((r) => r[1]))), max: kb(Math.max(0, ...thumbs.map((r) => r[1]))) }, base64KB: kb(b64.length), decodeMsOnMainThread: Math.round(decodeMs * 10) / 10 };
})()

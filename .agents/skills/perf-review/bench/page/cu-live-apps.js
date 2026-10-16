// A finished turn that looked at three apps: its folded group then shows three thumbnails.
(async () => {
  const N = window.__nav, C = window.__cu, shots = window.__cuShots, apps = window.__cuApps;
  const turn = 'cuwin001-live1';
  C.startTurn(turn);
  await N.wait(200);
  for (let k = 0; k < 9; k++) {
    C.step(turn, k, apps[k % 3], shots[k % 6]);
    await N.wait(250);
  }
  C.endTurn(turn);
  await N.wait(2500);
  const pane = document.querySelector('.thread-pane[data-thread="' + C.id + '"]');
  const thumbs = [...pane.querySelectorAll('.activity-thumbs img')];
  return { thumbs: thumbs.length, thumbsDecoded: thumbs.filter((i) => i.complete && i.naturalWidth).map((i) => i.naturalWidth + 'x' + i.naturalHeight) };
})()

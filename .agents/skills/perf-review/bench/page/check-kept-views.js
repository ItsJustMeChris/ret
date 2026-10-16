// Kept views: drafts follow a thread between its views, nothing is sent twice, scroll and keys survive
// mode switches, a rail jump reaches undrawn turns, boards switch back and forth intact.
(async () => {
  const { UI, TH, AC, CD } = window.__ret;
  const N = window.__nav;
  const out = {};
  const NL = String.fromCharCode(10);
  const setVal = (ta, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, v); ta.dispatchEvent(new Event('input', { bubbles: true })); };
  const shownPane = (id) => [...document.querySelectorAll('.thread-pane[data-thread="' + id + '"]')].find((p) => p.isConnected && !p.closest('.kept[data-away]'));
  const composerOf = (id) => shownPane(id)?.querySelector('.composer textarea');
  document.querySelector('.canvas-viewport').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
  // An engine-backed thread (sends go through the demo engine), as a canvas window and a Focus tab.
  const world = window.ret.world;
  const base = [...world.threads.values()].find((t) => t.provider === 'codex');
  const id = 'func0001-0000-4000-8000-000000000000';
  const now = Math.floor(Date.now() / 1000);
  const meta = { ...base.meta, id, sessionId: id, name: 'Func thread', preview: 'Func', updatedAt: now, recencyAt: now };
  const turns = Array.from({ length: 30 }, (_, t) => ({ id: 'func-t' + t, rootTurnId: null, items: [{ type: 'userMessage', id: 'func-t' + t + '-u', clientId: null, content: [{ type: 'text', text: 'Question ' + t, text_elements: [] }] }, { type: 'agentMessage', id: 'func-t' + t + '-m', text: '## Answer ' + t + NL + NL + 'Lorem ipsum dolor sit amet. '.repeat(40), phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }], itemsView: 'full', status: 'completed', error: null, startedAt: now - 9000 + t * 200, completedAt: now - 9000 + t * 200 + 100, durationMs: 100000 }));
  world.threads.set(id, { ...base, meta, turns, plans: {}, run: null, subscribed: false, failed: false, next: null, away: false });
  TH.useThreads.setState((s) => ({ threads: { ...s.threads, [id]: { ...meta, turns: [] } }, owner: { ...s.owner, [id]: 'codex' } }));
  AC.openThread(id, { mode: 'focus' });
  N.mode('focus')();
  await N.wait(1500);
  AC.openThread(id, { mode: 'canvas' });
  N.mode('canvas')();
  await N.wait(1500);

  // 1. A draft typed in the canvas window shows in the Focus tab's composer, and back.
  setVal(composerOf(id), 'hello');
  await N.wait(200);
  N.mode('focus')();
  await N.wait(300);
  out.draftInFocus = composerOf(id)?.value;
  setVal(composerOf(id), 'hello world');
  await N.wait(200);
  N.mode('canvas')();
  await N.wait(300);
  out.draftBackOnCanvas = composerOf(id)?.value;
  setVal(composerOf(id), '');
  await N.wait(200);

  // 2. A send from elsewhere (an answer to a question) goes out once, with a composer hidden in Focus.
  const userMsgs = () => world.threads.get(id).turns.flatMap((t) => t.items).filter((i) => i.type === 'userMessage' && i.content?.[0]?.text === 'send-once').length;
  CD.sendFromComposer(id, 'send-once');
  await N.wait(1500);
  out.sentOnce = userMsgs();

  // 3. Scroll in the Focus transcript survives a trip to the canvas (lingering) and back.
  N.mode('focus')();
  await N.wait(1500);
  const tr = () => shownPane(id)?.querySelector('.transcript');
  tr().scrollTop = -1500;
  await N.wait(300);
  const before = tr().scrollTop;
  N.mode('canvas')();
  await N.wait(500);
  N.mode('focus')();
  await N.wait(300);
  out.scrollKept = { before, after: tr().scrollTop };

  // 4. The rail jumps to the first turn even before the older turns are drawn.
  const id2 = 'long0001-0000-4000-8000-000000000000';
  N.longThread(id2, 40);
  UI.useUI.setState((s) => ({ tabs: [...s.tabs.filter((t) => t !== id2), id2], activeTab: id2 }));
  await N.painted();
  const drawnAtOpen = shownPane(id2).querySelectorAll('section.turn').length;
  const rail = shownPane(id2).querySelector('.turn-rail');
  const ticks = rail?.querySelectorAll('.rail-tick');
  ticks?.[0]?.click();
  await N.wait(2500); // the smooth scroll there takes ~2 s over a long thread
  const t2 = shownPane(id2).querySelector('.transcript');
  const firstTurn = shownPane(id2).querySelector('section.turn');
  const tb = t2.getBoundingClientRect(), fb = firstTurn.getBoundingClientRect();
  out.railJump = { drawnAtOpen, ticks: ticks?.length, drawnAfter: shownPane(id2).querySelectorAll('section.turn').length, firstTurnFromTop: Math.round(fb.top - tb.top), isFirst: firstTurn.dataset.turn === TH.useThreads.getState().live[id2].turnOrder[0] };
  await N.wait(3000);
  out.allDrawnLater = shownPane(id2).querySelectorAll('section.turn').length;

  // 5. Space in Focus doesn't arm the canvas's pan; j in Focus doesn't move the Inbox (built, hidden).
  N.mode('inbox')();
  await N.wait(800);
  const sel0 = UI.useUI.getState().inbox.selected;
  N.mode('focus')();
  await N.wait(300);
  document.activeElement?.blur?.();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
  await N.wait(100);
  out.hiddenKeys = { canvasSpacePan: !!document.querySelector('.canvas-viewport.space-pan'), inboxMoved: UI.useUI.getState().inbox.selected !== sel0 };
  window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));

  // 6. Boards: to another and back, the first one's windows are the same elements, and only the shown board's are in view.
  N.mode('canvas')();
  await N.wait(500);
  const cur = UI.useUI.getState().activeBoard;
  const firstWin = document.querySelector('.kept:not([data-away]) .cwin');
  const other = { id: 'empty-b', name: 'Empty', windows: [], viewport: { x: 0, y: 0, zoom: 1 } };
  UI.useUI.setState((s) => ({ boards: [...s.boards.filter((b) => b.id !== 'empty-b'), other], activeBoard: 'empty-b', focusedWindow: null }));
  await N.wait(400);
  const shownWinsOnEmpty = [...document.querySelectorAll('.cwin')].filter((w) => !w.closest('.kept[data-away]')).length;
  UI.useUI.setState({ activeBoard: cur, focusedWindow: null });
  await N.wait(400);
  out.boards = { shownWinsOnEmpty, sameElement: document.querySelector('.kept:not([data-away]) .cwin') === firstWin, firstOnScreen: (() => { const r = firstWin.getBoundingClientRect(); return r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight; })() };
  return out;
})()

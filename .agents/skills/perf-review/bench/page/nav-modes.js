// Mode switches and opening long threads, on the real board.
(async () => {
  const { UI } = window.__ret;
  const N = window.__nav;
  document.querySelector('.canvas-viewport').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2 }));
  const long1 = N.longThread('long0001-0000-4000-8000-000000000000', 40);
  const long2 = N.longThread('long0002-0000-4000-8000-000000000000', 20);
  const out = [{ long1, long2 }];
  UI.useUI.setState((s) => ({ tabs: [...s.tabs.filter((t) => !t.startsWith('long')), 'long0001-0000-4000-8000-000000000000', 'long0002-0000-4000-8000-000000000000'], activeTab: 'long0001-0000-4000-8000-000000000000' }));
  await N.wait(1500);
  out.push(await N.measure('canvas->focus (long, 40 turns)', N.mode('focus')));
  out.push(await N.measure('focus tab -> long 20 turns', () => UI.useUI.setState({ activeTab: 'long0002-0000-4000-8000-000000000000' })));
  out.push(await N.measure('focus tab -> long 40 turns', () => UI.useUI.setState({ activeTab: 'long0001-0000-4000-8000-000000000000' })));
  out.push(await N.measure('focus->canvas (102 windows)', N.mode('canvas'), 4000));
  out.push(await N.measure('canvas->code', N.mode('code')));
  out.push(await N.measure('code->inbox', N.mode('inbox')));
  out.push(await N.measure('inbox->canvas', N.mode('canvas'), 4000));
  out.push(await N.measure('canvas->inbox', N.mode('inbox')));
  out.push(await N.measure('inbox->focus', N.mode('focus')));
  out.push(await N.measure('focus->canvas again', N.mode('canvas'), 4000));
  return out;
})()

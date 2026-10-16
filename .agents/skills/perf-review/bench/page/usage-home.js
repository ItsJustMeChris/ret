// The home screen once (Focus with no tab open), which reads a year of usage and draws it, then back
// to the canvas: Focus stays built behind it, the home screen in it (see Kept).
(async () => {
  const { UI } = window.__ret;
  const N = window.__nav;
  const back = { mode: UI.useUI.getState().mode, activeTab: UI.useUI.getState().activeTab };
  UI.useUI.setState({ mode: 'focus', activeTab: null });
  let cells = 0;
  for (let i = 0; i < 60 && !cells; i++) {
    await N.wait(100);
    cells = document.querySelectorAll('.heat-cell[data-day]').length;
  }
  await N.wait(1500);
  UI.useUI.setState(back);
  await N.wait(1500);
  return { homeShown: !!document.querySelector('.empty, .stats, .tok-chart'), heatCells: cells };
})()

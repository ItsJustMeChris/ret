// Before viz-prep, for viz-cull: frames whose widget saves state. Each load reads its saved count n,
// reports a height of 100 + n and saves n + 1, so a frame that came back with the state it saved
// reports one more than before; one that came back with the state it started with, the same.
(window.__vizDoc =
  '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">' +
  '<script type="application/json" id="codex-visualization-widget-state">__CODEX_VISUALIZATION_WIDGET_STATE__</scr' + 'ipt><script>' +
  'let n=0;try{const g=JSON.parse(document.getElementById("codex-visualization-widget-state").textContent);n=(g.widgetState&&g.widgetState.n)||0}catch{}' +
  'addEventListener("message",(e)=>{if(!e.data||e.data.type!=="codex-visualization-initialize"||!e.ports[0])return;const port=e.ports[0];' +
  'port.postMessage({type:"height",height:100+n});port.postMessage({type:"widget-state-write",id:1,state:JSON.stringify({n:n+1})});});' +
  '</scr' + 'ipt></body></html>',
'frames save state')

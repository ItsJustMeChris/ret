// Every user message on the board (and every thread's preview) as the Codex app sends it: files and
// a referenced chat first, then "## My request for Codex:" and the message as escaped markdown with a
// chat mention in it. The PR takes these apart; main shows them as they are.
(() => {
  const { TH } = window.__ret;
  const NL = String.fromCharCode(10);
  const BS = String.fromCharCode(92);
  const ids = Object.keys(TH.useThreads.getState().threads);
  const other = ids[0];
  const wrap = (text) => [
    '# Files mentioned by the user:', '',
    '## server.ts: C:/work/real/src/server.ts', '',
    '## "Error log from the last run' + String.fromCharCode(0x2026) + '": C:/Users/me/AppData/Local/Temp/codex/pasted-1.txt', '',
    '## Referenced chats with Codex:',
    JSON.stringify([{ threadId: other, title: 'Earlier chat' }]), '',
    '## My request for Codex:',
    text.slice(0, 400).replace(/\*/g, BS + '*') + ' and see [@Earlier chat](thread://' + other + ') too' + BS,
    'thanks &amp; regards',
  ].join(NL);
  const s = TH.useThreads.getState();
  const live = {};
  let n = 0;
  for (const [id, lt] of Object.entries(s.live)) {
    const items = { ...lt.items };
    for (const [iid, it] of Object.entries(lt.items)) {
      if (it.type !== 'userMessage') continue;
      items[iid] = { ...it, content: it.content.map((c) => (c.type === 'text' ? { ...c, text: wrap(c.text) } : c)) };
      n++;
    }
    live[id] = { ...lt, items };
  }
  const threads = {};
  for (const [id, t] of Object.entries(s.threads)) threads[id] = { ...t, preview: wrap(t.preview || 'Thread ' + id.slice(0, 6)) };
  TH.useThreads.setState({ live: { ...s.live, ...live }, threads });
  return 'wrapped ' + n + ' user messages, ' + Object.keys(threads).length + ' previews';
})()

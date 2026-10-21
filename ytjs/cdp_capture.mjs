// CDP capture v5: log ALL videoplayback bodies with sizes to understand
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
const WS_URL = 'ws://127.0.0.1:9222/devtools/browser/ea3657fa-9034-4333-b6fc-24709b029510';
const ws = new WebSocket(WS_URL, { perMessageDeflate: false });
let id = 0;
const pending = new Map();
const send = (method, params, sessionId) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
});
let pageSession = null;
let saved = 0;

ws.on('message', async (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result ?? msg.error); pending.delete(msg.id); return; }
  if (msg.method === 'Target.attachedToTarget') {
    pageSession = msg.params.sessionId;
    await send('Network.enable', { maxPostDataSize: 1048576 }, pageSession);
    console.log('capturing ALL videoplayback bodies...');
  }
  if (msg.sessionId === pageSession && msg.method === 'Network.requestWillBeSent') {
    const r = msg.params.request;
    if (r.method === 'POST' && r.url.includes('videoplayback') && r.postData) {
      const buf = Buffer.from(r.postData, 'base64');
      const rn = new URL(r.url).searchParams.get('rn');
      console.log(`body: ${buf.length}b rn=${rn}`);
      const file = `/tmp/browser-sabr-any-${saved++}.bin`;
      writeFileSync(file, buf);
      writeFileSync(`/tmp/browser-sabr-any-url-${saved - 1}.txt`, r.url);
      if (saved >= 6) { console.log('done'); process.exit(0); }
    }
  }
});

ws.on('open', async () => {
  const { targetInfos } = await send('Target.getTargets', {});
  const tab = targetInfos.find(t => t.type === 'page' && t.url.includes('youtube.com/watch'));
  await send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
});
ws.on('error', (e) => console.error('ws:', e.message));
setTimeout(() => { console.log('timeout with', saved); process.exit(0); }, 35000);

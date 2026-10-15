// Mock model-gateway for e2e: like the gateway's Claude Code backend, it sends
// nothing (not even headers) until the whole turn is done, then replays it as
// one Anthropic SSE burst. Every event is logged as one JSON line on stdout.
import http from 'node:http';

const delayMs = Number(process.env.DELAY_MS ?? 130000);
const log = (event, extra = {}) => console.log(JSON.stringify({ at: Date.now(), event, ...extra }));

http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const started = Date.now();
    let request = {};
    try {
      request = JSON.parse(body);
    } catch {}
    log('request', { model: request.model, stream: !!request.stream });
    let replied = false;
    res.on('close', () => {
      if (!replied) log('client-cancelled', { ms: Date.now() - started });
    });
    setTimeout(() => {
      if (res.destroyed) return;
      replied = true;
      const message = { id: 'msg_e2e', type: 'message', role: 'assistant', model: request.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
      const events = [
        ['message_start', { type: 'message_start', message }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'E2E_SLOW_TURN_OK' } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'E2E_SLOW_TURN_OK' }], stop_reason: 'end_turn' }));
      }
      log('replied', { ms: Date.now() - started });
    }, delayMs);
  });
}).listen(8790, () => log('listening', { delayMs }));

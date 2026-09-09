const callId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const text = (value, max = 2000) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max) : '';

export function normalizeCall(record, activationAt) {
  if (!record || !callId.test(record.id) || !['inbound', 'outbound'].includes(record.direction) ||
      !['ended', 'failed'].includes(record.status) || !Number.isFinite(Date.parse(record.startedAt))) throw new Error('Invalid phone call record');
  const turns = Array.isArray(record.turns) ? record.turns.filter(turn => ['caller', 'agent'].includes(turn?.role) && typeof turn.text === 'string') : [];
  // The gateway's "caller" role means the other party in either direction.
  const caller = turns.filter(turn => turn.role === 'caller').map(turn => text(turn.text, 900));
  return {
    id: record.id, direction: record.direction, startedAt: record.startedAt,
    from: text(record.from, 40), to: text(record.to, 40), callStatus: record.status,
    reason: text(record.reason, 150), goal: text(record.goal, 1000),
    transcript: turns.slice(0, 100).map(turn => ({ role: turn.role, text: text(turn.text, 1200) })),
    transcriptTruncated: turns.length > 100,
    summary: [...new Set([...caller.slice(0, 2), ...caller.slice(-3)])].join(' / ').slice(0, 1800) || 'No caller transcript was recorded.',
    status: Date.parse(record.startedAt) < Date.parse(activationAt) ? 'reference' : 'pending',
  };
}

export function notification(call) {
  return `Phone call ${call.direction === 'inbound' ? 'from' : 'to'} ${call.direction === 'inbound' ? call.from : call.to}\n` +
    `Started: ${call.startedAt}\nStatus: ${call.callStatus}\n\n` +
    `Other party’s words: “${call.summary.slice(0, 1800)}”\n\n` +
    `The call is saved in our conversation. Reply here to discuss it or tell me what to do next.\nCall reference: ${call.id}`;
}

export function createInboxEngine({ store, request, deliver, mirror, now = () => Date.now(), activationAt, historyNotBefore = '1970-01-01T00:00:00Z', onError = () => {} }) {
  const activated = store.metadata('activationAt', activationAt || new Date(now()).toISOString());
  const belongsToOwner = call => Date.parse(call.startedAt) >= Date.parse(historyNotBefore);
  const visibleCalls = () => store.list().filter(belongsToOwner);
  let syncing;
  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      const records = await request('GET', '/orchestrations?limit=100');
      if (!Array.isArray(records)) throw new Error('Invalid phone history response');
      const cutoff = now() - 7 * 86400000;
      const started = Date.now();
      let imported = 0;
      for (const item of records.slice().sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))) {
        if (!callId.test(item?.id) || !['ended', 'failed'].includes(item.status) || !belongsToOwner(item) || Date.parse(item.startedAt) < cutoff || store.get(item.id)) continue;
        if (imported >= 10 || Date.now() - started > 8000) break;
        const record = await request('GET', `/orchestrations/${item.id}`);
        if (record.id !== item.id) throw new Error('Phone history identity mismatch');
        const call = normalizeCall(record, activated);
        if (store.list().some(parent => store.attempt(`callback:${parent.id}`)?.callbackId === call.id)) call.status = 'reference';
        store.insert(call);
        imported++;
      }
      store.setMetadata('lastSyncAt', new Date(now()).toISOString());
      for (const call of visibleCalls()) {
        const attemptId = `notice:${call.id}`;
        const attempt = store.attempt(attemptId);
        // Import existing calls for context without replaying old notifications.
        if (call.status === 'reference' || call.status === 'resolved') continue;
        if (!attempt && deliver) {
          const body = notification(call);
          // Persist before any network effect. Unknown delivery after a crash
          // must never be retried as if it definitely did not happen.
          if (store.claim(attemptId, { status: 'sending', at: new Date(now()).toISOString(), text: body })) {
            try {
              const receipt = await deliver(body, call.id);
              store.finish(attemptId, { status: 'sent', text: body, receipt });
            } catch {
              store.finish(attemptId, { status: 'unknown', text: body });
              onError('notification_unconfirmed');
            }
          }
        }
        const sent = store.attempt(attemptId);
        if (sent?.status === 'sent' && !sent.mirrored && mirror) {
          try {
            await mirror(sent.text, call.id, sent.receipt);
            store.finish(attemptId, { ...sent, mirrored: true });
          } catch { onError('transcript_mirror_pending'); }
        }
      }
    })().finally(() => { syncing = undefined; });
    return syncing;
  }
  function context() {
    const all = visibleCalls();
    const pending = all.filter(call => call.status === 'pending' || call.status === 'working');
    const recent = all.filter(call => !pending.includes(call)).slice(0, 3);
    return { pendingCount: pending.length, calls: [...pending.slice(0, 8), ...recent].map(call => ({
      ...call, summary: call.summary.slice(0, 1000), transcript: call.transcript.slice(-4).map(turn => ({ ...turn, text: turn.text.slice(0, 300) })),
      notification: store.attempt(`notice:${call.id}`)?.status,
      callback: store.attempt(`callback:${call.id}`),
    })) };
  }
  async function tool(args, { owner = false, selectedCallId } = {}) {
    if (args.action === 'list') { await sync(); return context(); }
    if (!callId.test(args.callId || '')) throw new Error('Use a callId from this inbox');
    const call = store.get(args.callId);
    if (!call || !belongsToOwner(call)) throw new Error('Call not found in this Claw’s inbox');
    if (args.action === 'read') return call;
    if (args.action === 'publish') {
      if (!text(args.summary).trim()) throw new Error('Provide the factual call summary');
      return store.update(call.id, value => {
        value.summary = text(args.summary);
        for (const field of ['callerName', 'requestedAction', 'proposedTime', 'timezone']) if (args[field] !== undefined) value[field] = text(args[field], 300);
      });
    }
    if (!owner) throw new Error('Follow-up actions require the owner’s private conversation');
    if (args.action === 'callback') {
      if (call.status === 'resolved') return { status: 'already_resolved', outcome: call.outcome };
      const existing = store.attempt(`callback:${call.id}`);
      if (existing) return { ...existing, repeated: true, instruction: 'Check the existing callback; do not create another call.' };
      if (visibleCalls().filter(item => item.status === 'pending' || item.status === 'working').length > 1 && selectedCallId !== call.id) throw new Error('Several calls need a decision. Ask the owner to reply to the relevant call notice before calling back.');
      if (!text(args.goal).trim()) throw new Error('Provide the owner-authorized callback goal');
      const to = call.direction === 'inbound' ? call.from : call.to;
      if (!/^\+[1-9]\d{7,14}$/.test(to)) throw new Error('This call has no verified callback number');
      const id = `callback:${call.id}`;
      if (!store.claim(id, { status: 'starting', at: new Date(now()).toISOString() })) return { ...store.attempt(id), repeated: true };
      store.update(call.id, value => { value.status = 'working'; });
      try {
        const result = await request('POST', '/orchestrations', { to, goal: text(args.goal, 4000) });
        if (!callId.test(result?.orchestrationId || '')) throw new Error('Missing callback identity');
        const attempt = { status: 'running', callbackId: result.orchestrationId };
        store.finish(id, attempt);
        return { ...attempt, instruction: 'Read the callback transcript and verify the outcome before marking complete.' };
      } catch {
        store.finish(id, { status: 'unknown', at: store.attempt(id).at, instruction: 'The callback may have started. Check phone history and use reconcile to link the matching callback; it was not retried.' });
        return store.attempt(id);
      }
    }
    if (args.action === 'reconcile') {
      const id = `callback:${call.id}`, attempt = store.attempt(id);
      if (!attempt || !['unknown', 'starting'].includes(attempt.status)) throw new Error('There is no uncertain callback to reconcile');
      if (!callId.test(args.callbackId || '')) throw new Error('Choose an existing callback from phone history');
      const callback = await request('GET', `/orchestrations/${args.callbackId}`);
      const to = call.direction === 'inbound' ? call.from : call.to;
      if (callback.id !== args.callbackId || callback.direction !== 'outbound' || callback.to !== to || Date.parse(callback.startedAt) < Date.parse(attempt.at || '9999-01-01')) throw new Error('That callback does not match the uncertain attempt');
      const linked = { status: 'running', callbackId: callback.id };
      store.finish(id, linked);
      return linked;
    }
    if (args.action === 'complete') {
      if (call.status === 'resolved') return { status: 'already_resolved', outcome: call.outcome };
      if (!text(args.outcome).trim()) throw new Error('Describe the verified outcome');
      const attempt = store.attempt(`callback:${call.id}`);
      if (attempt) {
        if (!attempt.callbackId) throw new Error('Resolve the uncertain callback before marking complete');
        const callback = await request('GET', `/orchestrations/${attempt.callbackId}`);
        if (callback.status !== 'ended' || !callback.turns?.some(turn => turn.role === 'caller' && turn.text?.trim())) throw new Error('The callback has not ended with a recorded response; inspect it before completing');
      } else if (!args.noCallbackNeeded) throw new Error('Use callback for a phone confirmation, or explicitly record why no callback was needed');
      return store.update(call.id, value => { value.status = 'resolved'; value.outcome = text(args.outcome); value.resolvedAt = new Date(now()).toISOString(); });
    }
    throw new Error('Unsupported phone handoff action');
  }
  return { sync, context, tool, wait: () => syncing || Promise.resolve() };
}

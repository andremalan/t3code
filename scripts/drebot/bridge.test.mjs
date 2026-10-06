import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore, collectReplies, dispatchPending, eventPrompt, flushPosts, routeEvent, stableId } from './bridge.mjs'
import { bridgeTick, catchUp } from './cli.mjs'
import { pairingCode } from './t3.mjs'
import { slackPages } from './slack.mjs'

const route = { projectId: 'project', modelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol', options: [{ id: 'reasoningEffort', value: 'xhigh' }] }, workspaceStrategy: { type: 'root' }, runtimeMode: 'auto-accept-edits' }
const config = { teamId: 'T123', botUserId: 'U123', ownerUserId: 'UHUMAN', allowedUsers: ['UHUMAN'], activatedAt: '1', allowDms: true, defaultRoute: route, channels: { C123: route }, botToken: 'test' }
const event = { type: 'message', user: 'UHUMAN', channel: 'C123', ts: '2.000001', text: '<@U123> help' }
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'drebot-test-'))
  const store = new BridgeStore(join(dir, 'bridge.sqlite'))
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  return store
}

test('mention and message deliveries deduplicate durably and replies retain one T3 conversation', async t => {
  const store = fixture(t)
  const first = store.record(event, route, config.teamId)
  assert.equal(store.record({ ...event, type: 'app_mention' }, route, config.teamId).inserted, false)
  const calls = []
  const rpc = async (tag, command) => { calls.push({ tag, command }); if (calls.length === 1) throw new Error('Lost response after acceptance') }
  await dispatchPending(store, rpc, 'drebot')
  store.db.prepare('UPDATE inbox SET next_attempt=0').run()
  await dispatchPending(store, rpc, 'drebot')
  assert.deepEqual(calls[0], calls[1])
  assert.equal(calls[1].command.reuseExistingThread, undefined)
  assert.deepEqual(calls[1].command.modelSelection, route.modelSelection)
  const reply = { ...event, ts: '3.000001', thread_ts: event.ts, text: 'more context' }
  const routed = routeEvent({ team_id: config.teamId, event: reply }, config, store)
  assert.ok(routed)
  const second = store.record(reply, routed.route, config.teamId)
  assert.equal(second.conversation.thread_id, first.conversation.thread_id)
  await dispatchPending(store, rpc, 'drebot')
  assert.equal(calls[2].tag, 'orchestration.dispatchCommand')
  assert.equal(calls[2].command.dispatchMode.type, 'queue_after_active')
  assert.equal(store.conversations().length, 1)
})

test('hosted pairing links exchange against the backend host', () => {
  assert.deepEqual(pairingCode('https://app.t3.codes/pair?host=https%3A%2F%2Ft3.example.com%2F#token=TEST'), { code: 'TEST', origin: 'https://t3.example.com' })
  assert.deepEqual(pairingCode('https://app.t3.codes/pair?host=file%3A%2F%2Ftmp#token=TEST'), { code: '', origin: '' })
})

test('authenticated owner identity is distinguished from other requesters', t => {
  const store = fixture(t)
  const { conversation } = store.record(event, route, config.teamId)
  assert.match(eventPrompt(event, conversation, route, 'drebot', event.user), /sender is Andre, the configured owner/)
  assert.match(eventPrompt(event, conversation, route, 'drebot', 'UOTHER'), /different requester from Andre/)
})

test('bot loops, wrong teams, edits, old events, and unmentioned channel posts do not launch work', t => {
  const store = fixture(t)
  for (const changed of [{ bot_id: 'B123' }, { user: config.botUserId }, { subtype: 'message_changed' }, { ts: '0' }, { text: 'hello' }])
    assert.equal(routeEvent({ team_id: config.teamId, event: { ...event, ...changed } }, config, store), null)
  assert.equal(routeEvent({ team_id: 'TOTHER', event }, config, store), null)
  assert.ok(routeEvent({ team_id: config.teamId, event: { ...event, channel: 'D123', channel_type: 'im', text: 'hello' } }, config, store))
})

test('final output is relayed once and accepted messages remain watched until projected', async t => {
  const store = fixture(t)
  const recorded = store.record(event, route, config.teamId)
  store.dispatched(store.pending()[0])
  let conversation = store.conversation(recorded.conversation.id)
  collectReplies(store, conversation, { runs: [], messages: [] })
  assert.equal(store.conversation(conversation.id).watching, 1)
  const projection = { runs: [{ id: 'run1', status: 'completed', userMessageId: stableId(`message:${recorded.eventId}`) }], messages: [
    { role: 'assistant', runId: 'run1', text: 'progress', streaming: false },
    { role: 'assistant', runId: 'run1', text: 'Done', streaming: false },
  ] }
  collectReplies(store, conversation, projection)
  collectReplies(store, conversation, projection)
  assert.equal(store.pendingPosts().length, 1)
  assert.match(store.pendingPosts()[0].text, /^🤖 AI: Directed\n\nDone$/)
  assert.equal(store.conversation(conversation.id).watching, 0)
  const calls = []
  await flushPosts(store, async (...args) => { calls.push(args); return { ts: '4' } }, config)
  await flushPosts(store, async (...args) => { calls.push(args); return { ts: '5' } }, config)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].thread_ts, event.ts)
})

test('unknown write outcomes are quarantined while explicit rate limits retry', async t => {
  const store = fixture(t)
  const { conversation } = store.record(event, route, config.teamId)
  const unknown = store.enqueue(conversation, 'first')
  let count = 0
  await flushPosts(store, async () => { count++; throw new Error('Connection lost') }, config)
  await flushPosts(store, async () => { count++; return { ts: '4' } }, config)
  assert.equal(count, 1)
  assert.equal(store.issues().outbox[0].id, unknown)
  const rate = store.enqueue(conversation, 'second')
  await flushPosts(store, async () => { throw Object.assign(new Error('rate'), { retryAfter: 2 }) }, config)
  assert.equal(store.db.prepare('SELECT status FROM outbox WHERE id=?').get(rate).status, 'pending')
  assert.equal(store.pendingPosts().length, 0)
  store.db.prepare('UPDATE outbox SET status=\'sending\' WHERE id=?').run(rate)
  const reader = new BridgeStore(join(store.db.location(), '..', 'bridge.sqlite'))
  reader.close()
  assert.equal(store.db.prepare('SELECT status FROM outbox WHERE id=?').get(rate).status, 'sending')
  store.recoverInterruptedSends()
  assert.equal(store.db.prepare('SELECT status FROM outbox WHERE id=?').get(rate).status, 'uncertain')
})

test('gap recovery retains its cursor when pagination fails and catches mapped replies', async t => {
  const store = fixture(t)
  store.record(event, route, config.teamId)
  store.setCursor('history:C123', '2')
  const cfg = { ...config, allowDms: false }
  assert.match((await catchUp(cfg, store, () => {}, async () => ({ messages: [], has_more: true })))[0].error, /incomplete history/)
  assert.equal(store.cursor('history:C123'), '2')
  const ingested = []
  await catchUp(cfg, store, value => ingested.push(value.event), async method => ({ messages: method === 'conversations.history' ? [] : [{ ...event, ts: '3', thread_ts: event.ts }] }))
  assert.equal(ingested[0].thread_ts, event.ts)
  assert.ok(Number(store.cursor('history:C123')) > 2)
})

test('only explicitly allowed requesters can start agent work', t => {
  const store = fixture(t)
  assert.equal(routeEvent({ team_id: config.teamId, event: { ...event, user: 'USTRANGER', channel: 'D123', channel_type: 'im' } }, config, store), null)
  const shared = { ...config, channels: { C123: { ...route, allowedUsers: ['*'] } } }
  assert.ok(routeEvent({ team_id: config.teamId, event: { ...event, user: 'USTRANGER' } }, shared, store))
})

test('private T3 runs are never relayed and malformed replies do not block another conversation', async t => {
  const store = fixture(t)
  const first = store.record(event, route, config.teamId)
  const second = store.record({ ...event, ts: '3', thread_ts: '3' }, route, config.teamId)
  await dispatchPending(store, async () => {}, 'drebot')
  const calls = []
  await bridgeTick(config, store, async (_tag, { threadId }) => ({
    runs: [
      { id: 'private', status: 'completed', userMessageId: 'PRIVATE' },
      { id: threadId, status: 'completed', userMessageId: stableId(`message:${threadId === first.conversation.thread_id ? first.eventId : second.eventId}`) },
    ],
    messages: [
      { runId: 'private', role: 'assistant', text: 'Private T3-only note' },
      { runId: threadId, role: 'assistant', text: threadId === first.conversation.thread_id ? 'x'.repeat(40000) : 'Valid reply' },
    ],
  }), async (_method, params) => { calls.push(params); return { ts: '4' } }, 'drebot', () => {})
  assert.equal(calls.length, 2)
  assert.ok(calls.some(row => row.text.includes('Valid reply')))
  assert.ok(calls.every(row => !row.text.includes('Private T3-only note')))
  assert.equal(store.issues().health.length, 1)
})

test('link boundaries reject earlier recovered messages and a second Slack mapping is refused', t => {
  const store = fixture(t)
  const linked = store.record({ ...event, ts: '10', thread_ts: '2' }, route, config.teamId)
  assert.equal(routeEvent({ team_id: config.teamId, event: { ...event, ts: '3', thread_ts: '2' } }, config, store), null)
  assert.throws(() => store.register({ id: 'second', channel: 'C123', rootTs: '11', threadId: linked.conversation.thread_id, route }), /already linked/)
})

test('a failed root blocks a follow-up until the root is dispatched', async t => {
  const store = fixture(t)
  store.record(event, route, config.teamId)
  store.record({ ...event, ts: '3', thread_ts: event.ts }, route, config.teamId)
  const calls = []
  await dispatchPending(store, async (_tag, command) => { calls.push(command); throw new Error('offline') }, 'drebot')
  await dispatchPending(store, async (_tag, command) => calls.push(command), 'drebot')
  assert.equal(calls.length, 1)
  store.db.prepare('UPDATE inbox SET next_attempt=0').run()
  await dispatchPending(store, async (_tag, command) => calls.push(command), 'drebot')
  await dispatchPending(store, async (_tag, command) => calls.push(command), 'drebot')
  assert.equal(calls.length, 3)
  assert.ok(calls[1].initialMessage)
  assert.equal(calls[2].type, 'message.dispatch')
})

test('history read rate limits honor Retry-After and recovery isolates failing channels', async t => {
  let attempts = 0
  const waits = []
  await slackPages('conversations.history', {}, 'test', async () => {
    if (!attempts++) throw Object.assign(new Error('rate'), { retryAfter: 2 })
    return { messages: [] }
  }, async ms => waits.push(ms))
  assert.deepEqual(waits, [2000])
  const store = fixture(t)
  const ingested = []
  await catchUp({ ...config, allowDms: false, channels: { C123: route, C456: route } }, store, payload => ingested.push(payload.event), async (_method, { channel }) => {
    if (channel === 'C123') throw new Error('forbidden')
    return { messages: [{ ...event, channel: 'C456' }] }
  })
  assert.equal(store.cursor('history:C123', '1'), '1')
  assert.ok(Number(store.cursor('history:C456')) > 1)
  assert.equal(ingested[0].channel, 'C456')
})

test('offline mentions in recently active unlinked threads are recovered without their older replies', async t => {
  const store = fixture(t)
  const cfg = { ...config, allowDms: false }
  const ingested = []
  await catchUp(cfg, store, payload => {
    const routed = routeEvent(payload, cfg, store)
    if (routed) { store.record(routed.event, routed.route, cfg.teamId); ingested.push(payload.event.ts) }
  }, async method => ({ messages: method === 'conversations.history'
    ? [{ ...event, text: 'not for bot', reply_count: 2, latest_reply: '10' }]
    : [{ ...event, ts: '3', text: 'side note' }, { ...event, ts: '10' }] }))
  assert.deepEqual(ingested, ['10'])
  assert.equal(store.conversations()[0].start_ts, '10')
})

test('queued top-level posts acquire a Slack root and future replies retain their mapping', async t => {
  const store = fixture(t)
  const conversation = store.register({ id: 'outgoing', channel: 'C123', rootTs: '', route, startTs: '2' })
  store.enqueue(conversation, 'An update')
  await flushPosts(store, async (_method, params) => { assert.equal(params.thread_ts, undefined); return { ts: '3' } }, config)
  const routed = routeEvent({ team_id: config.teamId, event: { ...event, ts: '4', thread_ts: '3', text: 'follow-up' } }, config, store)
  assert.ok(routed)
  assert.equal(store.record(routed.event, routed.route, config.teamId).conversation.id, 'outgoing')
})

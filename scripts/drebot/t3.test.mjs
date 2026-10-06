import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('standalone Drebot T3 authentication and RPC', async t => {
  const previousState = process.env.DREBOT_STATE
  const previousUrl = process.env.DREBOT_T3_URL
  mkdirSync(join(homedir(), 'tmp'), { recursive: true })
  const scratch = mkdtempSync(join(homedir(), 'tmp', 'drebot-t3-test-'))
  process.env.DREBOT_STATE = scratch
  delete process.env.DREBOT_T3_URL
  const { STATE, CONFIG } = await import('./paths.mjs')
  const { T3_TOKEN_FILE, pairingCode, t3Token, t3Pair, t3Dispatch } = await import('./t3.mjs')
  const credential = { token: 'fake-private-bearer', expiresAt: '2099-01-01T00:00:00Z', origin: 'https://saved.example.test' }
  const saveCredential = (record = credential) => {
    mkdirSync(CONFIG, { recursive: true })
    writeFileSync(T3_TOKEN_FILE, JSON.stringify(record), { mode: 0o600 })
  }
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status })
  const accessToken = { access_token: 'fake-new-bearer', token_type: 'Bearer', expires_in: 3600, scope: 'orchestration:read' }
  t.afterEach(() => {
    t.mock.restoreAll()
    delete process.env.DREBOT_T3_URL
    for (const name of readdirSync(scratch)) rmSync(join(scratch, name), { recursive: true, force: true })
  })
  t.after(() => {
    if (previousState === undefined) delete process.env.DREBOT_STATE
    else process.env.DREBOT_STATE = previousState
    if (previousUrl === undefined) delete process.env.DREBOT_T3_URL
    else process.env.DREBOT_T3_URL = previousUrl
    rmSync(scratch, { recursive: true, force: true })
  })

  function fakeSocket(onRequest) {
    const sockets = []
    class FakeWebSocket {
      constructor(url) {
        this.url = new URL(url)
        this.sent = []
        this.closed = false
        sockets.push(this)
        queueMicrotask(() => this.onopen?.())
      }
      send(raw) {
        const frame = JSON.parse(raw)
        this.sent.push(frame)
        if (frame._tag === 'Request') queueMicrotask(() => onRequest(this, frame))
      }
      message(frame) { this.onmessage?.({ data: JSON.stringify(frame) }) }
      close() { this.closed = true; this.onclose?.({ reason: 'fake-private-ticket' }) }
    }
    t.mock.method(globalThis, 'WebSocket', function(url) { return new FakeWebSocket(url) })
    return sockets
  }

  await t.test('state override and private credential metadata', () => {
    assert.equal(STATE, scratch)
    assert.equal(CONFIG, join(scratch, 'config'))
    assert.equal(t3Token(), null)
    saveCredential()
    assert.equal(t3Token().expired, false)
    saveCredential({ ...credential, expiresAt: '2000-01-01T00:00:00Z' })
    assert.equal(t3Token().expired, true)
    saveCredential({ ...credential, expiresAt: 'invalid' })
    assert.equal(t3Token().expired, true)
    saveCredential({ token: 12 })
    assert.equal(t3Token(), null)
  })

  await t.test('direct, hosted, query and bare pairing codes, restricted to HTTP backends', () => {
    assert.deepEqual(pairingCode(' bare-code '), { code: 'bare-code', origin: '' })
    assert.deepEqual(pairingCode('http://127.0.0.1:3773/pair#token=direct'), { code: 'direct', origin: 'http://127.0.0.1:3773' })
    assert.deepEqual(pairingCode('https://app.t3.codes/pair?host=https%3A%2F%2Fbackend.example.test%2F#token=hosted'), { code: 'hosted', origin: 'https://backend.example.test' })
    assert.deepEqual(pairingCode('https://app.t3.codes/pair?host=http%3A%2F%2F127.0.0.1%3A3773%2F&token=query'), { code: 'query', origin: 'http://127.0.0.1:3773' })
    for (const invalid of ['', 'ftp://example.test/pair#token=code', 'https://app.t3.codes/pair?host=file%3A%2F%2Ftmp%2Fx#token=code', 'https://app.t3.codes/pair?host=#token=code', 'https://user:password@example.test/pair#token=code'])
      assert.deepEqual(pairingCode(invalid), { code: '', origin: '' })
  })

  await t.test('real paired HTTP exchange saves atomically as 0600 and archives the previous bytes', async t => {
    saveCredential()
    const previous = readFileSync(T3_TOKEN_FILE)
    // Cover replacement of a legacy record that was written with a loose mode.
    const { chmodSync } = await import('node:fs')
    chmodSync(T3_TOKEN_FILE, 0o644)
    let exchanged
    const server = createServer(async (request, result) => {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      exchanged = { url: request.url, method: request.method, type: request.headers['content-type'], body: new URLSearchParams(Buffer.concat(chunks).toString()) }
      result.writeHead(200, { 'content-type': 'application/json' })
      result.end(JSON.stringify(accessToken))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const origin = `http://127.0.0.1:${server.address().port}`
    const result = await t3Pair(`https://app.t3.codes/pair?host=${encodeURIComponent(origin + '/')}#token=fake-one-use-code`)
    assert.deepEqual(result, { ok: true, expiresAt: t3Token().expiresAt, origin })
    assert.equal(exchanged.url, '/oauth/token')
    assert.equal(exchanged.method, 'POST')
    assert.equal(exchanged.type, 'application/x-www-form-urlencoded')
    assert.deepEqual(Object.fromEntries(exchanged.body), {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'fake-one-use-code', subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      client_label: 'Drebot', client_device_type: 'bot', client_os: process.platform,
    })
    assert.equal(t3Token().token, accessToken.access_token)
    assert.equal(statSync(T3_TOKEN_FILE).mode & 0o777, 0o600)
    const archive = join(STATE, 'archive', 't3-tokens')
    const archived = readdirSync(archive)
    assert.equal(archived.length, 1)
    assert.deepEqual(readFileSync(join(archive, archived[0])), previous)
    assert.equal(statSync(join(archive, archived[0])).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(CONFIG), ['t3-token.json'])
  })

  await t.test('explicit environment URL wins over config and hosted pairing URL', async () => {
    saveCredential()
    writeFileSync(join(CONFIG, 'drebot.json'), JSON.stringify({ t3Url: 'https://config.example.test' }))
    process.env.DREBOT_T3_URL = 'https://explicit.example.test/'
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://explicit.example.test/oauth/token')
      assert.equal(options.redirect, 'error')
      assert.ok(options.signal instanceof AbortSignal)
      return response(accessToken)
    })
    const result = await t3Pair('https://app.t3.codes/pair?host=https%3A%2F%2Fhosted.example.test#token=fake-code')
    assert.equal(result.origin, 'https://explicit.example.test')
  })

  await t.test('Drebot config URL selects the RPC backend', async () => {
    saveCredential()
    writeFileSync(join(CONFIG, 'drebot.json'), JSON.stringify({ t3Url: 'https://config.example.test/' }))
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, 'https://config.example.test/api/auth/websocket-ticket')
      assert.equal(options.headers.Authorization, `Bearer ${credential.token}`)
      return response({ ticket: 'fake-private-ticket' })
    })
    const sockets = fakeSocket(ws => ws.message({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: { connected: true } } }))
    assert.deepEqual(await t3Dispatch('server.getConfig', {}), { connected: true })
    assert.equal(sockets[0].url.origin, 'wss://config.example.test')
  })

  await t.test('invalid explicit endpoint fails without network or exposing its value', async () => {
    saveCredential()
    process.env.DREBOT_T3_URL = 'file:///fake-private-bearer'
    t.mock.method(globalThis, 'fetch', () => { assert.fail('must not fetch') })
    await assert.rejects(t3Dispatch('server.getConfig', {}), /must be an HTTP or HTTPS/)
    assert.deepEqual(await t3Pair('fake-code'), { ok: false, why: 'Drebot T3 URL must be an HTTP or HTTPS URL without embedded credentials' })
  })

  await t.test('refused or malformed pairing responses preserve existing credential and redact server bodies', async () => {
    saveCredential()
    const original = readFileSync(T3_TOKEN_FILE)
    t.mock.method(globalThis, 'fetch', async () => response({ reason: 'fake-one-use-code fake-private-bearer' }, 401))
    assert.equal((await t3Pair('https://backend.example.test/pair#token=fake-one-use-code')).why, 'T3 authentication request refused (HTTP 401); pairing codes may be spent or expired')
    t.mock.method(globalThis, 'fetch', async () => response({ ...accessToken, token_type: 'DPoP' }))
    assert.deepEqual(await t3Pair('https://backend.example.test/pair#token=fake-code'), { ok: false, why: 'T3 returned an invalid bearer credential' })
    assert.deepEqual(readFileSync(T3_TOKEN_FILE), original)
  })

  await t.test('archive failure leaves the old credential intact and removes the staged bearer', async () => {
    saveCredential()
    const original = readFileSync(T3_TOKEN_FILE)
    writeFileSync(join(STATE, 'archive'), 'blocked archive')
    t.mock.method(globalThis, 'fetch', async () => response(accessToken))
    const result = await t3Pair('https://backend.example.test/pair#token=fake-code')
    assert.equal(result.ok, false)
    assert.match(result.why, /Could not safely save/)
    assert.deepEqual(readFileSync(T3_TOKEN_FILE), original)
    assert.deepEqual(readdirSync(CONFIG), ['t3-token.json'])
  })

  await t.test('fresh ticket per connection, protocol 2, Request/Ack/Exit and stream firstChunk', async () => {
    saveCredential()
    process.env.DREBOT_T3_URL = 'https://explicit.example.test'
    let issued = 0
    t.mock.method(globalThis, 'fetch', async () => response({ ticket: `fake-ticket-${++issued}` }))
    const sockets = fakeSocket((ws, request) => {
      assert.deepEqual(request, { _tag: 'Request', id: '1', tag: 'server.getConfig', payload: {}, headers: [] })
      ws.message({ _tag: 'Exit', requestId: 'unrelated', exit: { _tag: 'Failure' } })
      ws.message({ _tag: 'Chunk', requestId: '1', values: [] })
      ws.message({ _tag: 'Chunk', requestId: '1', values: [{ streamed: true }] })
      ws.message({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: { completed: true } } })
    })
    assert.deepEqual(await t3Dispatch('server.getConfig', {}), { completed: true })
    assert.deepEqual(await t3Dispatch('server.getConfig', {}, { firstChunk: true }), { streamed: true })
    assert.equal(issued, 2)
    for (const [index, socket] of sockets.entries()) {
      assert.equal(socket.url.protocol, 'wss:')
      assert.equal(socket.url.pathname, '/ws')
      assert.equal(socket.url.searchParams.get('orchestrationProtocol'), '2')
      assert.equal(socket.url.searchParams.get('wsTicket'), `fake-ticket-${index + 1}`)
      assert.deepEqual(socket.sent.slice(1), [{ _tag: 'Ack', requestId: '1' }, { _tag: 'Ack', requestId: '1' }])
      assert.equal(socket.closed, true)
    }
  })

  await t.test('early close and RPC failure reject promptly without reflecting close reasons or exit payloads', async () => {
    saveCredential()
    process.env.DREBOT_T3_URL = 'https://explicit.example.test'
    t.mock.method(globalThis, 'fetch', async () => response({ ticket: 'fake-private-ticket' }))
    fakeSocket(ws => ws.close())
    await assert.rejects(t3Dispatch('server.getConfig', {}), { message: 'T3 websocket closed before the RPC completed; outcome unknown' })
    fakeSocket(ws => ws.message({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Failure', cause: 'fake-private-bearer fake-private-ticket' } }))
    await assert.rejects(t3Dispatch('server.getConfig', {}), { message: 'T3 refused the RPC request' })
  })

  await t.test('RPC timeout closes a stalled socket', async () => {
    saveCredential()
    process.env.DREBOT_T3_URL = 'https://explicit.example.test'
    t.mock.method(globalThis, 'fetch', async () => response({ ticket: 'fake-private-ticket' }))
    const sockets = fakeSocket(() => {})
    await assert.rejects(t3Dispatch('server.getConfig', {}, { timeoutMs: 10 }), { message: 'T3 RPC request timed out' })
    assert.equal(sockets[0].closed, true)
  })

  await t.test('HTTP auth uses a native 20 second abort timeout and masks transport failures', async () => {
    saveCredential()
    process.env.DREBOT_T3_URL = 'https://explicit.example.test'
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    t.mock.method(AbortSignal, 'timeout', ms => { assert.equal(ms, 20000); return timeout(10) })
    t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    // AbortSignal timers are unref'ed. Hold the event loop while the deliberately stalled fetch waits.
    const keepAlive = setInterval(() => {}, 1000)
    try {
      await assert.rejects(t3Dispatch('server.getConfig', {}), { message: 'T3 authentication request timed out' })
      assert.match((await t3Pair('fake-code')).why, /^T3 authentication request timed out;/)
    } finally { clearInterval(keepAlive) }
    t.mock.method(globalThis, 'fetch', () => { throw new Error('fake-private-bearer fake-private-ticket') })
    await assert.rejects(t3Dispatch('server.getConfig', {}), { message: 'T3 authentication request failed or returned an unreadable response' })
  })
})

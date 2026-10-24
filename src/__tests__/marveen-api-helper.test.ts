// #2232: scripts/marveen-api.sh is the one allow-listed command a strict-profile agent has for
// the dashboard API. These run the real script against a local fake server and check what
// reaches the wire: method, path, JSON body, the token header and X-Agent-Id. Also the failure
// paths, because an agent decides from the exit code: a bad call or a missing token must fail
// loudly before anything is sent, and a redirect must not carry the token to another host.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HELPER = join(REPO, 'scripts', 'marveen-api.sh')
const dir = mkdtempSync(join(tmpdir(), 'marveen-api-helper-test-'))
const TOKEN = 'test-token-0123456789'
const tokenFile = join(dir, 'token')
writeFileSync(tokenFile, TOKEN + '\n', 'utf-8')

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }
let seen: Seen[] = []
let reply: { status: number; body: string; headers?: Record<string, string> } = { status: 200, body: '{"ok":true}' }

function listen(handler: (req: IncomingMessage, body: string, res: import('node:http').ServerResponse) => void): Promise<Server> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => handler(req, body, res))
    })
    srv.listen(0, '127.0.0.1', () => resolve(srv))
  })
}

let api: Server
let other: Server
let otherHits = 0
const port = (s: Server) => (s.address() as AddressInfo).port

beforeAll(async () => {
  api = await listen((req, body, res) => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body })
    res.writeHead(reply.status, { 'Content-Type': 'application/json', ...(reply.headers ?? {}) })
    res.end(reply.body)
  })
  other = await listen((_req, _body, res) => { otherHits++; res.writeHead(200); res.end('{}') })
})
afterAll(() => { api.close(); other.close() })
beforeEach(() => {
  seen = []
  otherHits = 0
  reply = { status: 200, body: '{"ok":true}' }
})

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('bash', [HELPER, ...args], {
      env: { PATH: process.env.PATH!, MARVEEN_API_BASE: `http://127.0.0.1:${port(api)}`, MARVEEN_TOKEN_FILE: tokenFile, ...env },
      timeout: 20_000,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr })
    })
  })
}

function file(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content, 'utf-8')
  return p
}

describe('marveen-api.sh: what each verb sends', () => {
  it('memory-save: POST with the file content, the token header and X-Agent-Id', async () => {
    const r = await run(['memory-save', 'dani', 'warm', 'k1, k2', file('m.txt', 'tartalom `backtick` és $(nem fut)\n')])
    expect(r.code).toBe(0)
    expect(seen).toHaveLength(1)
    const [s] = seen
    expect(s.method).toBe('POST')
    expect(s.url).toBe('/api/memories')
    expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(s.headers['x-agent-id']).toBe('dani')
    expect(JSON.parse(s.body)).toEqual({ agent_id: 'dani', content: 'tartalom `backtick` és $(nem fut)\n', category: 'warm', keywords: 'k1, k2' })
  })

  it('memory-search: the accented query is encoded, and the label header is printed first', async () => {
    reply = { status: 200, body: '[]', headers: { 'X-Memory-Search': 'strict=true; relaxed=false; hits=0' } }
    const r = await run(['memory-search', 'dani', 'funkcionális', '--category', 'warm', '--strict', '--since', '2026-10-01'])
    expect(r.code).toBe(0)
    const url = new URL(seen[0].url, 'http://x')
    expect(url.pathname).toBe('/api/memories')
    expect(Object.fromEntries(url.searchParams)).toEqual({ agent: 'dani', q: 'funkcionális', category: 'warm', strict: '1', since: '2026-10-01' })
    expect(seen[0].url).toContain('q=funkcion%C3%A1lis')
    expect(r.stdout.split('\n')[0]).toBe('X-Memory-Search: strict=true; relaxed=false; hits=0')
  })

  it('memory-search: a missing label header is printed as MISSING, also on a 400', async () => {
    reply = { status: 400, body: '' }
    const r = await run(['memory-search', 'dani', 'x'])
    expect(r.code).toBe(1)
    expect(r.stdout.split('\n')[0]).toMatch(/^X-Memory-Search: MISSING/)
  })

  it('memory-move: a category-only PATCH, never agent_id', async () => {
    const r = await run(['memory-move', '4242', 'cold', 'dani'])
    expect(r.code).toBe(0)
    expect(seen[0].method).toBe('PATCH')
    expect(seen[0].url).toBe('/api/memories/4242')
    expect(JSON.parse(seen[0].body)).toEqual({ category: 'cold', updated_by: 'dani' })
    expect(seen[0].headers['x-agent-id']).toBe('dani')
  })

  it('memory-update and memory-list', async () => {
    expect((await run(['memory-update', '7', 'dani', file('u.txt', 'új')])).code).toBe(0)
    expect(seen[0].method).toBe('PUT')
    expect(seen[0].url).toBe('/api/memories/7')
    expect(JSON.parse(seen[0].body)).toEqual({ content: 'új', updated_by: 'dani' })
    expect((await run(['memory-list', 'dani', 'hot'])).code).toBe(0)
    expect(seen[1].method).toBe('GET')
    expect(seen[1].url).toBe('/api/memories?agent=dani&category=hot&limit=40')
  })

  it('message-close: notify is a real JSON boolean, the result comes from a file', async () => {
    expect((await run(['message-close', '43071', '--no-notify'])).code).toBe(0)
    expect(seen[0].method).toBe('PUT')
    expect(seen[0].url).toBe('/api/messages/43071')
    expect(JSON.parse(seen[0].body)).toEqual({ status: 'done', notify: false })
    expect((await run(['message-close', '5', '--failed', '--result-file', file('r.txt', 'mit csináltam')])).code).toBe(0)
    expect(JSON.parse(seen[1].body)).toEqual({ status: 'failed', result: 'mit csináltam' })
  })

  it('directive-verify, daily-log and the three approval verbs', async () => {
    await run(['directive-verify', '43081'])
    await run(['daily-log', 'dani', file('d.txt', '## 14:00 -- Téma\nMi történt')])
    await run(['approval-request', 'dani', 'email_send', '3600', file('a.txt', 'Mit és miért'), '--content-hash', 'sha256:abcdef12'])
    await run(['approval-status', 'ab12'])
    await run(['approval-consume', 'ab12', 'memory_maintenance', 'dani'])
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /api/messages/43081',
      'POST /api/daily-log',
      'POST /api/approvals',
      'GET /api/approvals/ab12',
      'POST /api/approvals/ab12/consume',
    ])
    expect(JSON.parse(seen[1].body)).toEqual({ agent_id: 'dani', content: '## 14:00 -- Téma\nMi történt' })
    expect(JSON.parse(seen[2].body)).toEqual({ agent_id: 'dani', category: 'email_send', action_description: 'Mit és miért', timeout_seconds: 3600, content_hash: 'sha256:abcdef12' })
    expect(JSON.parse(seen[4].body)).toEqual({ category: 'memory_maintenance', consumer: 'dani' })
  })

  it('message: goes through agent-msg.sh with the text from the file', async () => {
    reply = { status: 200, body: '{"id":99}' }
    const r = await run(['message', 'dani', 'samu', file('msg.txt', 'Szia, "idézet" és `kód`')])
    expect(r.code, r.stderr + r.stdout).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('/api/messages')
    expect(JSON.parse(seen[0].body)).toEqual({ from: 'dani', to: 'samu', content: 'Szia, "idézet" és `kód`' })
  })
})

describe('marveen-api.sh: failures are loud, and nothing is sent on a bad call', () => {
  it('an unknown verb exits 2 and sends nothing', async () => {
    const r = await run(['memory-delete', '1'])
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('unknown verb')
    expect(seen).toHaveLength(0)
  })

  it('a malformed argument exits 2 and sends nothing', async () => {
    expect((await run(['memory-move', '12; rm', 'cold', 'dani'])).code).toBe(2)
    expect((await run(['memory-save', 'dani', 'lukewarm', 'k', file('x.txt', 'x')])).code).toBe(2)
    expect((await run(['memory-save', 'dani', 'warm', 'k', file('e.txt', '  \n')])).code).toBe(2)
    expect((await run(['message', 'dani', 'samu'])).code).toBe(2)
    expect(seen).toHaveLength(0)
  })

  it('no token file exits 2 with a loud message and sends nothing', async () => {
    const r = await run(['directive-verify', '1'], { MARVEEN_TOKEN_FILE: join(dir, 'missing-token') })
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/no readable token file/)
    expect(seen).toHaveLength(0)
  })

  it('a non-2xx answer exits 1 with the status', async () => {
    reply = { status: 409, body: '{"error":"already_consumed"}' }
    const r = await run(['approval-consume', 'ab12', 'memory_maintenance', 'dani'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('HTTP 409')
  })

  it('a redirect is not followed, so the token never reaches another host', async () => {
    reply = { status: 302, body: '', headers: { Location: `http://127.0.0.1:${port(other)}/steal` } }
    const r = await run(['directive-verify', '1'])
    expect(r.code).toBe(1)
    expect(otherHits).toBe(0)
  })

  it('an unreachable dashboard exits 3', async () => {
    const r = await run(['directive-verify', '1'], { MARVEEN_API_BASE: 'http://127.0.0.1:9' })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('could not be reached')
  })

  it('the token is never in the argv the helper passes on', async () => {
    // The python core is started with the verb arguments only; the token is read inside it.
    const sh = (await import('node:fs')).readFileSync(HELPER, 'utf-8')
    expect(sh).not.toMatch(/dashboard-token|TOKEN=/)
  })
})

#!/usr/bin/env node
// diffmate 데몬 — 크롬 익스텐션과 로컬 JSON 저장소를 잇는다.
//
//   yarn notes            127.0.0.1:7777 에서 뜬다
//   DIFFMATE_PORT=… yarn notes
//
// 저장소는 레포별 디렉토리 · PR별 파일이다. 어느 디렉토리에서 띄우든 상관없고,
// repo·pr 은 매 요청이 들고 온다(익스텐션이 GitHub URL에서 뽑는다).
//
// 매 요청마다 디스크에서 읽고 쓴다 — Claude Code 가 JSON 을 직접 고쳐도 바로 보이게 하려는 것이다.

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

const PORT = Number(process.env.DIFFMATE_PORT || 7777)
const ROOT = process.env.DIFFMATE_DIR || join(homedir(), '.diffmate')
const ALLOWED_ORIGINS = ['https://github.com']

const slug = (repo) => repo.replace('/', '__').replace(/[^\w.@-]/g, '_')
const storePath = (repo, pr) => join(ROOT, slug(repo), `${Number(pr)}.json`)
export const hashLine = (text) => createHash('sha1').update(normalize(text)).digest('hex').slice(0, 12)
const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

async function load(repo, pr) {
  try {
    return JSON.parse(await readFile(storePath(repo, pr), 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') { throw err }
    return { repo, pr: Number(pr), round: 0, files: {}, notes: [] }
  }
}

// 같은 PR 을 두 탭에서 열어두면 마지막 쓰기가 이긴다. 임시 파일 후 rename 이라 반쯤 쓰인 JSON 은 안 남는다.
async function save(repo, pr, data) {
  const file = storePath(repo, pr)
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
  return data
}

function newNote(input) {
  const lineText = normalize(input.lineText)
  return {
    id: `n_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`,
    kind: input.kind === 'request' || input.kind === 'memo' ? input.kind : 'question',
    status: 'open',
    path: input.path,
    line: input.line ? Number(input.line) : null,   // 0·빈값은 파일 단위 메모다
    endLine: input.endLine == null ? null : Number(input.endLine),
    side: input.side === 'LEFT' ? 'LEFT' : 'RIGHT',
    lineText,
    textHash: hashLine(lineText),
    commit: input.commit || null,
    view: input.view || 'all',   // 'all' = 전체 diff, 그 외는 커밋 해시
    body: String(input.body ?? '').trim(),
    answer: null,
    answeredAt: null,
    thread: [],   // 첫 답변 뒤에 이어지는 주고받기
    round: Number(input.round || 0),
    createdAt: new Date().toISOString(),
  }
}

const routes = {
  async 'GET /health'() {
    return { ok: true, root: ROOT, port: PORT }
  },

  async 'GET /notes'({ query }) {
    return load(query.get('repo'), query.get('pr'))
  },

  // 익스텐션이 메모를 하나 만든다.
  async 'POST /notes'({ body }) {
    const data = await load(body.repo, body.pr)
    const note = newNote(body)
    data.notes.push(note)
    await save(body.repo, body.pr, data)
    return note
  },

  // 본문 수정 · 종류 변경 · resolve 처리.
  async 'PATCH /notes'({ query, body }) {
    const repo = query.get('repo'); const pr = query.get('pr')
    const data = await load(repo, pr)
    const note = data.notes.find((n) => n.id === body.id)
    if (!note) { return { error: 'not found', httpStatus: 404 } }
    if (typeof body.body === 'string') {
      note.body = body.body.trim()
      note.status = note.answer ? 'answered' : 'open'
    }
    // 답글을 여러 번 주고받은 뒤 '수정'을 누르면 마지막으로 내가 쓴 줄을 고친다.
    if (body.editReply && typeof body.editReply.body === 'string') {
      const turn = note.thread?.[body.editReply.index]
      if (turn && turn.by === 'me') { turn.body = body.editReply.body.trim() }
    }
    if (body.kind) { note.kind = body.kind }
    // 사용자가 답글을 달면 다시 미답변으로 돌아간다.
    if (typeof body.reply === 'string' && body.reply.trim()) {
      note.thread = note.thread || []
      note.thread.push({ by: 'me', body: body.reply.trim(), at: new Date().toISOString() })
      note.status = 'open'
    }
    if (body.status) { note.status = body.status }
    await save(repo, pr, data)
    return note
  },

  async 'DELETE /notes'({ query }) {
    const repo = query.get('repo'); const pr = query.get('pr'); const id = query.get('id')
    const data = await load(repo, pr)
    data.notes = data.notes.filter((n) => n.id !== id)
    await save(repo, pr, data)
    return { ok: true }
  },

  // 어떤 PR 에 메모가 남아 있는지 — Claude 쪽에서 훑을 때 쓴다.
  async 'GET /index'() {
    const out = []
    let repos = []
    try { repos = await readdir(ROOT) } catch { return { repos: out } }
    for (const repoDir of repos) {
      let files = []
      try { files = await readdir(join(ROOT, repoDir)) } catch { continue }
      for (const f of files.filter((f) => f.endsWith('.json'))) {
        try {
          const data = JSON.parse(await readFile(join(ROOT, repoDir, f), 'utf8'))
          const open = data.notes.filter((n) => n.status === 'open').length
          out.push({ repo: data.repo, pr: data.pr, notes: data.notes.length, open })
        } catch { /* 깨진 파일은 목록에서만 빠진다 */ }
      }
    }
    return { repos: out }
  },
}

function cors(req, res) {
  const origin = req.headers.origin
  if (origin && (ALLOWED_ORIGINS.includes(origin) || origin.startsWith('chrome-extension://'))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
}

createServer(async (req, res) => {
  cors(req, res)
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const handler = routes[`${req.method} ${url.pathname}`]
  if (!handler) { res.writeHead(404).end('{}'); return }

  let body = {}
  if (req.method !== 'GET') {
    const chunks = []
    for await (const chunk of req) { chunks.push(chunk) }
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = {} }
    }
  }

  try {
    const result = await handler({ query: url.searchParams, body })
    // 메모 자체에 status('open') 필드가 있어서, HTTP 상태는 다른 키로 받는다.
    const status = result?.httpStatus || 200
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(result))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String(err?.message || err) }))
  }
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`diffmate  http://127.0.0.1:${PORT}  →  ${ROOT}\n`)
})

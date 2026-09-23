#!/usr/bin/env node
// Claude Code 쪽에서 저장소를 읽고 쓰는 길. JSON 을 손으로 고치다 깨뜨리지 않으려고 둔다.
//
//   node notes-cli.mjs list [repo] [pr]                     메모 보기 (인자 없으면 전체 PR 요약)
//   node notes-cli.mjs answer <repo> <pr> <noteId>          답변을 stdin 으로 받는다
//   node notes-cli.mjs reply  <repo> <pr> <noteId>          되물음에 답글 달기 (stdin)
//   node notes-cli.mjs edit   <repo> <pr> <noteId> <turn>   내가 쓴 답 고치기 (turn=자리번호|answer)
//   node notes-cli.mjs summarize <repo> <pr>                {"path":{"summary","risk","order"}} 를 stdin 으로
//   node notes-cli.mjs stale <repo> <pr>                    리뷰 커밋으로 낡은 요약 찾기
//   node notes-cli.mjs reanchor <repo> <pr> <noteId> <line> 새 줄 내용을 stdin 으로 (요청 처리 후)
//   node notes-cli.mjs move <repo> <pr> <noteId> <새 경로>   파일을 잘못 찾아간 메모 옮기기
//   node notes-cli.mjs normalize <repo> <pr>                저장 형식을 현재 규칙으로 맞추기

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { promisify } from 'node:util'

const ROOT = process.env.DIFFMATE_DIR || join(homedir(), '.diffmate')
const norm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim()
const hash = (t) => createHash('sha1').update(norm(t)).digest('hex').slice(0, 12)
const exec = promisify(execFile)

// PR 의 파일마다 지금 붙어 있는 blob sha. 요약이 어느 버전을 보고 쓰였는지 가르는 기준이 된다.
async function prFileShas(repo, pr) {
  const { stdout } = await exec('gh', [
    'api', '--paginate', `repos/${repo}/pulls/${Number(pr)}/files`,
    '--jq', '.[] | [.filename, .sha] | @tsv',
  ], { maxBuffer: 32 * 1024 * 1024 })
  const map = new Map()
  for (const line of stdout.split('\n')) {
    const [file, sha] = line.split('\t')
    if (file && sha) { map.set(file, sha) }
  }
  return map
}

const pathFor = (repo, pr) => join(ROOT, repo.replace('/', '__').replace(/[^\w.@-]/g, '_'), `${Number(pr)}.json`)

async function read(repo, pr) {
  try { return JSON.parse(await readFile(pathFor(repo, pr), 'utf8')) } catch { return null }
}
async function write(repo, pr, data) {
  await mkdir(dirname(pathFor(repo, pr)), { recursive: true })
  await writeFile(pathFor(repo, pr), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}
async function stdin() {
  const chunks = []
  for await (const c of process.stdin) { chunks.push(c) }
  return Buffer.concat(chunks).toString('utf8').trim()
}

const [cmd, repo, pr, ...rest] = process.argv.slice(2)

if (cmd === 'list' && !repo) {
  const out = []
  for (const dir of await readdir(ROOT).catch(() => [])) {
    for (const f of (await readdir(join(ROOT, dir)).catch(() => [])).filter((f) => f.endsWith('.json'))) {
      const d = JSON.parse(await readFile(join(ROOT, dir, f), 'utf8'))
      const open = d.notes.filter((n) => n.status === 'open').length
      out.push(`${d.repo}#${d.pr}  메모 ${d.notes.length} · 미답변 ${open} · 요약 ${Object.keys(d.files || {}).length}`)
    }
  }
  console.log(out.join('\n') || '메모 없음')
} else if (cmd === 'list') {
  const d = await read(repo, pr)
  if (!d) { console.error('저장소 없음'); process.exit(1) }
  console.log(JSON.stringify(d, null, 2))
} else if (cmd === 'answer') {
  const [id] = rest
  const text = await stdin()
  const d = await read(repo, pr)
  const note = d?.notes.find((n) => n.id === id)
  if (!note) { console.error(`메모 없음: ${id}`); process.exit(1) }
  note.answer = text
  note.answeredAt = new Date().toISOString()
  note.status = 'answered'
  d.round = Math.max(d.round || 0, note.round || 0) + 0
  await write(repo, pr, d)
  console.log(`답변 기록: ${id}`)
} else if (cmd === 'edit') {
  // 내가 쓴 답을 고친다. <turn> 은 thread 의 0부터 센 자리, 'answer' 면 첫 답변.
  const [id, turn] = rest
  const text = await stdin()
  const d = await read(repo, pr)
  const note = d?.notes.find((n) => n.id === id)
  if (!note) { console.error(`메모 없음: ${id}`); process.exit(1) }
  if (turn === 'answer') {
    note.answer = text
  } else {
    const i = Number(turn)
    const entry = note.thread?.[i]
    if (!entry) { console.error(`그 자리에 글이 없다: ${turn}`); process.exit(1) }
    if (entry.by !== 'claude') { console.error('내가 쓴 것만 고친다'); process.exit(1) }
    entry.body = text
  }
  await write(repo, pr, d)
  console.log(`고침: ${id} ${turn}`)
} else if (cmd === 'reply') {
  // 첫 답변 뒤에 이어지는 답글. 사용자가 되물은 것에 답할 때 쓴다.
  const [id] = rest
  const text = await stdin()
  const d = await read(repo, pr)
  const note = d?.notes.find((n) => n.id === id)
  if (!note) { console.error(`메모 없음: ${id}`); process.exit(1) }
  note.thread = note.thread || []
  note.thread.push({ by: 'claude', body: text, at: new Date().toISOString() })
  note.status = 'answered'
  await write(repo, pr, d)
  console.log(`답글 기록: ${id}`)
} else if (cmd === 'summarize') {
  const map = JSON.parse(await stdin())
  const d = (await read(repo, pr)) || { repo, pr: Number(pr), round: 0, files: {}, notes: [] }
  // sha 를 못 받아도 요약은 기록한다 — 네트워크 때문에 작업이 멈추면 안 된다
  const shas = await prFileShas(repo, pr).catch(() => null)
  if (!shas) { console.error('경고: PR 파일 sha 를 못 받았다. stale 이 이 요약을 판정하지 못한다') }
  for (const [path, value] of Object.entries(map)) {
    if (shas?.has(path)) { map[path] = { ...value, sha: shas.get(path) } }
  }
  d.files = { ...d.files, ...map }
  await write(repo, pr, d)
  console.log(`파일 요약 ${Object.keys(map).length}건 기록`)
} else if (cmd === 'stale') {
  const d = await read(repo, pr)
  if (!d) { console.error('저장소 없음'); process.exit(1) }
  const shas = await prFileShas(repo, pr).catch((err) => {
    console.error(`gh 실패 — ${err.message.split('\n')[0]}`)
    process.exit(1)
  })

  const rows = []
  for (const [path, sha] of shas) {
    const file = d.files?.[path]
    if (!file) { rows.push(['요약 없음', path]); continue }
    if (!file.sha) { rows.push(['버전 모름', path]); continue }
    if (file.sha !== sha) { rows.push(['바뀜', path]) }
  }
  for (const path of Object.keys(d.files || {})) {
    if (!shas.has(path)) { rows.push(['PR 에서 빠짐', path]) }
  }

  if (!rows.length) { console.log('갱신할 요약 없음') }
  for (const [why, path] of rows) { console.log(`${why}\t${path}`) }
} else if (cmd === 'normalize') {
  // 저장 형식이 바뀌며 섞인 상태를 현재 규칙으로 맞춘다.
  // 규칙: 줄이 없으면 파일 메모(앵커 비움) / 줄이 있으면 앵커 해시를 다시 계산.
  const d = await read(repo, pr)
  if (!d) { console.error('저장소 없음'); process.exit(1) }
  const FIELDS = { endLine: null, side: 'RIGHT', commit: null, answer: null, answeredAt: null, round: 0 }
  let changed = 0
  for (const note of d.notes) {
    const before = JSON.stringify(note)
    for (const [k, v] of Object.entries(FIELDS)) {
      if (!(k in note)) { note[k] = v }
    }
    if (!note.line || !norm(note.lineText)) {
      note.line = null
      note.lineText = ''
      note.textHash = ''
    } else {
      note.lineText = norm(note.lineText)
      note.textHash = hash(note.lineText)
    }
    const last = note.thread?.[note.thread.length - 1]
    if (last?.by === 'me') {
      note.status = 'open'
    } else {
      note.status = note.answer ? (note.status === 'resolved' ? 'resolved' : 'answered') : 'open'
    }
    if (JSON.stringify(note) !== before) { changed += 1 }
  }
  await write(repo, pr, d)
  console.log(`형식 정리: ${changed}건 손봄 / 전체 ${d.notes.length}건`)
} else if (cmd === 'move') {
  // 파일을 잘못 찾아간 메모를 옮긴다. 옮기면 줄 앵커는 의미가 없어지므로 파일 메모가 된다.
  const [id, toPath] = rest
  const d = await read(repo, pr)
  const note = d?.notes.find((n) => n.id === id)
  if (!note) { console.error(`메모 없음: ${id}`); process.exit(1) }
  note.path = toPath
  note.line = null
  note.lineText = ''
  note.textHash = ''
  await write(repo, pr, d)
  console.log(`옮김: ${id} → ${toPath}`)
} else if (cmd === 'reanchor') {
  const [id, line] = rest
  const text = await stdin()
  const d = await read(repo, pr)
  const note = d?.notes.find((n) => n.id === id)
  if (!note) { console.error(`메모 없음: ${id}`); process.exit(1) }
  note.line = Number(line)
  note.lineText = norm(text)
  note.textHash = hash(text)
  await write(repo, pr, d)
  console.log(`앵커 갱신: ${id} → L${line}`)
} else {
  console.error(await readFile(new URL(import.meta.url)).then((b) => b.toString().split('\n').slice(2, 9).join('\n')))
  process.exit(1)
}

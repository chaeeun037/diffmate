// GitHub PR 의 Files changed 화면에 메모 버튼·카드를 얹는다.
//
// GitHub DOM 은 개편을 탄다. 그래서 클래스 이름 하나에 기대지 않고 여러 전략으로 찾고,
// 못 찾으면 콘솔에서 __diffmate.probe() 로 무엇이 안 잡혔는지 볼 수 있게 해뒀다.

(() => {
  const GAP = 24          // diff 오른쪽 끝과 카드 사이 여백
  const CARD_W = 300
  const MIN_RAIL = CARD_W + GAP + 16   // 이보다 좁으면 줄 아래 인라인으로 떨어뜨린다
  const POLL_MS = 3000

  const state = {
    ctx: null,            // { repo, pr, commit }
    data: { files: {}, notes: [] },
    rows: new Map(),      // path -> [row]
    cards: [],
    composer: null,
    offline: false,
    lastJson: '',
    // 새 Files changed 는 경로를 안 적고 sha256 해시만 쓴다. 알고 있는 경로를 해시로 바꿔 맞춘다.
    pathOfHash: new Map(),
  }

  // ── 픽셀 클로드 ────────────────────────────────────────
  // 이미지 파일 대신 rect 로 그린다. 16px 로 줄여도 안 뭉개진다.
  const PIXELS = [
    [2, 0, 5, 1], [2, 1, 5, 1],
    [0, 2, 9, 1],
    [2, 3, 5, 1],
    [2, 4, 1, 1], [4, 4, 1, 1], [6, 4, 1, 1],
  ]
  const EYES = [[3, 1], [5, 1]]

  function claudeIcon(size = 16) {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 9 5')
    svg.setAttribute('width', size)
    svg.setAttribute('height', size)
    svg.setAttribute('shape-rendering', 'crispEdges')
    for (const [x, y, w, h] of PIXELS) {
      const r = document.createElementNS(ns, 'rect')
      r.setAttribute('x', x); r.setAttribute('y', y)
      r.setAttribute('width', w); r.setAttribute('height', h)
      r.setAttribute('fill', 'currentColor')
      svg.appendChild(r)
    }
    for (const [x, y] of EYES) {
      const r = document.createElementNS(ns, 'rect')
      r.setAttribute('x', x); r.setAttribute('y', y)
      r.setAttribute('width', 1); r.setAttribute('height', 1)
      r.setAttribute('fill', '#1b1b1b')
      svg.appendChild(r)
    }
    return svg
  }

  // ── 데몬 ───────────────────────────────────────────────
  const api = (method, path, { query = {}, body } = {}) =>
    new Promise((resolve) => {
      chrome.runtime.sendMessage({ method, path, query, body }, (res) => resolve(res || { ok: false, offline: true }))
    })

  const norm = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  async function learnPaths(paths) {
    for (const path of paths) {
      if (!path || [...state.pathOfHash.values()].includes(path)) { continue }
      state.pathOfHash.set(await sha256Hex(path), path)
    }
  }

  async function hash(text) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(norm(text)))
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
  }

  // ── 어느 PR 을 보고 있나 ────────────────────────────────
  function detectContext() {
    // 변경 화면에서만 동작한다. 다른 탭에서는 아무것도 그리지 않는다.
    if (!location.pathname.includes('/changes')) { return null }
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
    if (!m) { return null }
    // /pull/N/changes/<sha> 는 그 커밋만 보는 화면이라 보이는 diff 가 다르다.
    // 어느 화면에서 쓴 메모인지 남겨야 나중에 줄이 안 맞을 때 이유를 안다.
    const view = location.pathname.match(/\/changes\/([0-9a-f]{7,40})/)?.[1] || 'all'
    return { repo: `${m[1]}/${m[2]}`, pr: Number(m[3]), commit: view === 'all' ? null : view, view }
  }

  // ── diff DOM 훑기 ──────────────────────────────────────
  const ROW_SEL = 'tr, [role="row"], [data-line-number], [data-grid-cell-id]'

  // DOM 에서 긁은 경로에는 zero-width·방향 제어 문자가 섞여 들어온다. 눈에는 같아 보이는데
  // Map.has 가 실패해서 요약이 통째로 안 붙는다(2026-09-21 log/index.ts·loadTiming.ts).
  const normPath = (p) => String(p ?? '')
    .normalize('NFC')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .trim()

  const BLOCK_SEL =
    '[data-tagsearch-path], [data-path], [data-file-path], copilot-diff-entry, ' +
    'div[id^="diff-"], [data-testid="diff-file"], [data-testid*="file-diff"]'

  const attrPath = (el) =>
    normPath(
      el.getAttribute('data-tagsearch-path') ||
      el.getAttribute('data-path') ||
      el.getAttribute('data-file-path') ||
      ''
    )

  const textPath = (el) =>
    normPath(
      el.querySelector('a[title*="/"], [title*="/"]')?.getAttribute('title') ||
      el.querySelector('a[href*="#diff-"]')?.textContent ||
      [...el.querySelectorAll('h3, h4, [class*="file-info"], [class*="Title"]')]
        .map((n) => n.textContent?.trim())
        .find((t) => t && t.includes('/') && t.includes('.') && t.length < 200) ||
      ''
    )

  function fileBlocks(force = false) {
    if (!force && state.blocksCache) { return state.blocksCache }
    const nodes = [...document.querySelectorAll(BLOCK_SEL)]
    const byPath = new Map()
    const push = (path, el) => {
      if (!path || !path.includes('.')) { return }
      if (!byPath.has(path)) { byPath.set(path, []) }
      byPath.get(path).push(el)
    }

    const rest = []
    for (const el of nodes) {
      const p = attrPath(el) || state.pathOfHash.get(String(el.id).match(/^diff-([0-9a-f]{64})$/)?.[1])
      if (p) { push(normPath(p), el) } else { rest.push(el) }
    }

    // 텍스트로 경로를 긁는 건 마지막 수단이다. 다른 후보를 품은 조상에 쓰면 목록 전체가
    // 그 파일로 잡혀서 남의 파일 줄에 메모가 붙는다(2026-09-21 AdBanner 메모가 loadTiming 에).
    for (const el of rest) {
      if (nodes.some((other) => other !== el && el.contains(other))) { continue }
      push(textPath(el), el)
    }

    const found = new Map()
    for (const [path, list] of byPath) {
      const withRows = list.filter((el) => el.querySelector(ROW_SEL))
      const pool = withRows.length ? withRows : list
      let best = pool[0]
      for (const el of pool) {
        if (best.contains(el)) { best = el }
      }

      // 고른 게 헤더만 담은 작은 요소면 줄이 하나도 안 잡힌다. 다른 파일을 품기 직전까지 올라간다.
      if (!best.querySelector(ROW_SEL)) {
        let cur = best
        while (cur.parentElement && cur.parentElement !== document.body) {
          const parent = cur.parentElement
          if (nodes.some((other) => !best.contains(other) && parent.contains(other) && attrPath(other) !== path)) { break }
          cur = parent
          if (cur.querySelector(ROW_SEL)) { best = cur; break }
        }
      }
      found.set(path, best)
    }

    // 안전장치 — 다른 파일 블록을 품고 있으면 그건 파일 블록이 아니다.
    for (const [path, el] of [...found]) {
      for (const [other, otherEl] of found) {
        if (other !== path && el !== otherEl && el.contains(otherEl)) { found.delete(path); break }
      }
    }
    state.blocksCache = found
    return found
  }

  function lineCells(rowEl) {
    const byAttr = [...rowEl.querySelectorAll('[data-line-number]')].filter((el) => el.getAttribute('data-line-number'))
    if (byAttr.length) { return byAttr.map((el) => ({ el, n: Number(el.getAttribute('data-line-number')) })) }

    const byGrid = [...rowEl.querySelectorAll('[data-grid-cell-id]')]
      .filter((el) => /line-?number/i.test(el.getAttribute('data-grid-cell-id') || '') || /line-?number/i.test(el.className || ''))
      .map((el) => ({ el, n: Number(String(el.textContent).trim()) }))
      .filter((c) => Number.isFinite(c.n))
    if (byGrid.length) { return byGrid }

    // 마지막 수단 — 행 앞쪽에서 숫자만 들어 있는 작은 셀을 줄번호로 본다.
    const cells = [...rowEl.children].slice(0, 3)
    return cells
      .map((el) => ({ el, n: Number(String(el.textContent).trim()) }))
      .filter((c) => Number.isFinite(c.n) && c.n > 0)
  }

  function parseRow(rowEl) {
    const numEls = lineCells(rowEl)
    if (!numEls.length) { return null }
    const cls = rowEl.className || ''
    const declaredSide = rowEl.querySelector('[data-diff-side]')?.getAttribute('data-diff-side')
    const isDeletion = declaredSide === 'left' || /deletion/.test(cls) || !!rowEl.querySelector('[class*="deletion"]')
    const picked = isDeletion ? numEls[0] : numEls[numEls.length - 1]
    const numEl = picked.el
    const line = picked.n
    if (!Number.isFinite(line)) { return null }

    const codeEl =
      rowEl.querySelector('.blob-code-inner, .diff-text-inner') ||
      rowEl.querySelector('[class*="diff-text"], [class*="blob-code"]') ||
      rowEl.lastElementChild
    const text = norm(codeEl?.textContent).replace(/^[+-]\s?/, '')

    return { line, side: isDeletion ? 'LEFT' : 'RIGHT', text, el: rowEl, numEl, codeEl }
  }

  // 줄이 어느 파일 것인지 거꾸로 되짚는다. 블록 안을 훑는 방식은 GitHub 이 구조를 바꿀 때마다 0건이 됐다.
  function pathForRowEl(rowEl) {
    // 이 UI 의 유일한 파일 표시는 diff-<경로의 sha256> 이다.
    const marked = rowEl.querySelector('[data-line-anchor], [data-grid-cell-id]')
    const token = marked?.getAttribute('data-line-anchor') || marked?.getAttribute('data-grid-cell-id') || rowEl.closest('[id^="diff-"]')?.id
    const m = token?.match(/diff-([0-9a-f]{64})/)
    if (m) {
      const byHash = state.pathOfHash.get(m[1])
      if (byHash) { return byHash }
    }

    const holder = rowEl.closest('[data-tagsearch-path], [data-path], [data-file-path]')
    if (holder) {
      const p = attrPath(holder)
      if (p) { return p }
    }
    for (const [path, block] of state.blocks || []) {
      if (block.contains(rowEl)) { return path }
    }
    return null
  }

  function scan() {
    state.rows = new Map()
    state.blocks = fileBlocks(true)

    let noParse = 0
    let noPath = 0
    const sampleNoPath = []
    for (const rowEl of document.querySelectorAll('tr, [role="row"]')) {
      if (rowEl.closest('.dm-inline-row')) { continue }
      const row = parseRow(rowEl)
      if (!row) { noParse += 1; continue }
      const path = pathForRowEl(rowEl)
      if (!path) {
        noPath += 1
        if (sampleNoPath.length < 2) { sampleNoPath.push(rowEl) }
        continue
      }
      if (!state.rows.has(path)) { state.rows.set(path, []) }
      state.rows.get(path).push(row)
    }

    const keys = Object.fromEntries([...state.rows].map(([k, v]) => [k, v.length]))
    const signature = JSON.stringify({ keys, noParse, noPath })
    if (signature !== state.lastScan) {
      state.lastScan = signature
      console.debug('[diffmate] 줄을 담은 키', keys, '· 줄로 못 읽음', noParse, '· 파일을 못 정함', noPath, sampleNoPath)
    }
    return state.rows
  }

  function findRow(note) {
    const rows = state.rows.get(normPath(note.path))
    if (!rows) { return null }
    // GitHub 은 화면 밖 줄을 떼었다 다시 붙인다. 떨어져 나간 요소에 카드를 달면 화면에 안 보인다.
    const alive = rows.filter((r) => r.el.isConnected)
    if (!alive.length) { return null }
    const byLine = alive.find((r) => r.line === note.line && r.side === note.side)
    if (byLine && norm(byLine.text) === note.lineText) { return byLine }
    // 빈 문자열로 맞추면 빈 줄 아무 데나 붙는다(실제로 L61 로 튀었다).
    const byText = note.lineText
      ? alive.find((r) => norm(r.text) === note.lineText && r.side === note.side)
      : null
    if (byText) { return byText }
    return byLine || null   // 내용은 바뀌었지만 줄은 살아 있는 경우
  }

  // ── 줄 옆 버튼 ─────────────────────────────────────────
  let hoverBtn = null

  function ensureHoverBtn() {
    if (hoverBtn) { return hoverBtn }
    hoverBtn = document.createElement('button')
    hoverBtn.className = 'dm-line-btn'
    hoverBtn.setAttribute('aria-label', '클로드에게 메모 남기기')
    hoverBtn.appendChild(claudeIcon(18))
    // GitHub 은 mousedown/pointerdown 에서도 코멘트 창을 연다. 세 가지를 다 막아야 네이티브 창이 같이 안 뜬다.
    for (const type of ['pointerdown', 'mousedown']) {
      hoverBtn.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation() }, true)
    }
    hoverBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation()
      if (hoverBtn._row) { openComposer(hoverBtn._row, hoverBtn._path) }
    })
    document.body.appendChild(hoverBtn)
    return hoverBtn
  }

  let blocksAt = 0

  function pathOfRow(rowEl) {
    for (const [path, block] of state.blocks || []) {
      if (block.contains(rowEl)) { return path }
    }
    // 방금 펼쳤거나 스크롤로 새로 붙은 파일은 지난 스캔에 없다. 잠깐 간격을 두고 다시 훑는다.
    const now = Date.now()
    if (now - blocksAt > 500) {
      blocksAt = now
      state.blocks = fileBlocks(true)
      for (const [path, block] of state.blocks) {
        if (block.contains(rowEl)) { return path }
      }
      console.debug('[diffmate] 줄은 찾았는데 어느 파일인지 못 찾음', rowEl)
    }
    return null
  }

  function attachHover() {
    document.addEventListener('mouseover', (e) => {
      if (!state.ctx) { return }
      const btn = ensureHoverBtn()
      const cell = e.target?.closest?.('tr, [role="row"], [data-grid-cell-id], [data-line-number]')
      const rowEl = cell?.closest?.('tr, [role="row"]') || cell
      if (!rowEl || rowEl.closest('.dm-inline-row')) {
        if (!e.target?.closest?.('.dm-line-btn')) { btn.classList.remove('dm-visible') }
        return
      }

      // 스캔 이후에 그려진 파일(스크롤로 뒤늦게 붙거나 방금 펼친 것)은 목록에 없다.
      // 그 자리에서 해석하지 않으면 아이콘이 직전 위치에 남아 메모를 못 단다.
      let path = null
      let row = null
      for (const [p, rows] of state.rows) {
        const hit = rows.find((r) => r.el === rowEl)
        if (hit) { path = p; row = hit; break }
      }
      if (!row) {
        row = parseRow(rowEl)
        path = row ? (pathForRowEl(rowEl) || pathOfRow(rowEl)) : null
      }
      if (!row || !path) { btn.classList.remove('dm-visible'); return }

      // 줄번호 칸에 겹치면 숫자와 GitHub 파란 + 를 가린다. 행 바깥 왼쪽에 세운다.
      const rect = rowEl.getBoundingClientRect()
      btn._row = row
      btn._path = path
      // 화면 기준으로 세운다. 새 Files changed 는 안쪽 컨테이너가 스크롤해서
      // 페이지 스크롤 좌표(window.scrollY)를 더하면 자리가 어긋난다.
      btn.style.top = `${rect.top + (rect.height - 22) / 2}px`
      btn.style.left = `${Math.max(2, rect.left - 26)}px`
      btn.classList.add('dm-visible')
    }, true)
  }

  // ── 작성 폼 ────────────────────────────────────────────
  function openComposer(row, path) {
    closeComposer()
    const box = document.createElement('div')
    box.className = 'dm-card dm-composer'
    box.addEventListener('keydown', (e) => e.stopPropagation())

    const head = document.createElement('div')
    head.className = 'dm-card-head'
    head.appendChild(claudeIcon(16))
    const select = document.createElement('select')
    select.className = 'dm-kind-select'
    select.innerHTML = '<option value="question">질문</option><option value="request">요청</option><option value="memo">메모</option>'
    head.appendChild(select)
    const where = document.createElement('span')
    where.textContent = `${path.split('/').pop()} · L${row.line}`
    head.appendChild(where)

    const ta = document.createElement('textarea')
    ta.placeholder = '이거 왜 이럼?'

    const actions = document.createElement('div')
    actions.className = 'dm-actions'
    const hint = document.createElement('span')
    hint.className = 'dm-hint'
    hint.textContent = '⌘Enter 저장'
    const cancel = button('취소', closeComposer)
    const submit = button('저장', () => commit(), true)
    actions.append(hint, cancel, submit)

    box.append(head, ta, actions)
    place(box, row, true)
    ta.focus()

    const commit = async () => {
      const body = ta.value.trim()
      if (!body) { return }
      const target = row
      const kind = select.value
      closeComposer()
      await save(target, path, kind, body)
    }

    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeComposer(); return }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit() }
    })
    state.composer = box
  }

  function button(label, onClick, primary = false) {
    const b = document.createElement('button')
    b.className = primary ? 'dm-btn dm-btn-primary' : 'dm-btn'
    b.type = 'button'
    b.textContent = label
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick() })
    return b
  }

  function closeComposer() {
    const row = state.composer?.closest?.('.dm-inline-row')
    state.composer?.remove()
    row?.remove()
    state.composer = null
    if (state.pendingRefresh) {
      state.pendingRefresh = false
      refresh(true)
    }
  }

  async function save(row, path, kind, body) {
    const res = await api('POST', '/notes', {
      body: {
        repo: state.ctx.repo,
        pr: state.ctx.pr,
        commit: state.ctx.commit,
        view: state.ctx.view,
        round: state.data.round || 0,
        path, kind, body,
        line: row.line ?? null,
        side: row.side || 'RIGHT',
        lineText: row.line ? norm(row.text) : '',
      },
    })
    if (!res.ok) { flashStatus('저장 실패 — 데몬이 떠 있나?'); return }
    await refresh(true)
  }

  // ── 카드 배치 ──────────────────────────────────────────
  function railLeft() {
    let right = 0
    for (const [, rows] of state.rows) {
      const r = rows[0]?.el?.closest('table, div')?.getBoundingClientRect()
      if (r) { right = Math.max(right, r.right) }
    }
    return right
  }

  function place(el, row, isComposer = false) {
    if (!row.line || row.el?.tagName !== 'TR') {
      el.classList.add('dm-inline')
      row.el.insertAdjacentElement('afterend', el)
      return
    }
    const rect = row.el.getBoundingClientRect()
    const left = railLeft()
    const inline = window.innerWidth - left < MIN_RAIL

    if (inline) {
      el.classList.add('dm-inline')
      row.el.insertAdjacentElement('afterend', wrapInlineRow(el, row))
      return
    }
    el.classList.remove('dm-inline')
    el.style.top = `${Math.max(8, rect.top)}px`
    el.style.left = `${left + GAP}px`
    if (isComposer) { el.style.width = '340px' }
    document.body.appendChild(el)
  }

  // 인라인으로 떨어질 때는 표 구조를 깨지 않게 한 줄짜리 tr 로 감싼다.
  function wrapInlineRow(el, row) {
    // GitHub 코멘트 창과 같은 선에서 시작하게 코드 칸 왼쪽에 맞춘다.
    const rowLeft = row.el.getBoundingClientRect().left
    const codeLeft = row.codeEl?.getBoundingClientRect().left
    if (Number.isFinite(codeLeft) && codeLeft > rowLeft) {
      el.style.marginLeft = `${Math.round(codeLeft - rowLeft)}px`
    }
    const tr = document.createElement('tr')
    tr.className = 'dm-inline-row'
    const td = document.createElement('td')
    td.colSpan = row.el.children.length || 3
    // 흰 칸으로 두면 추가·삭제 줄 배경이 끊긴다. 붙어 있는 줄의 배경색을 그대로 쓴다.
    // GitHub 쪽 규칙이 이기므로 important 로 올린다.
    const opaque = (el) => {
      if (!el) { return null }
      const c = getComputedStyle(el).backgroundColor
      return c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent' ? c : null
    }
    const bg =
      opaque(row.codeEl) ||
      opaque(row.numEl) ||
      opaque(row.el) ||
      opaque(row.el.querySelector('[data-diff-side]'))
    if (bg) {
      td.style.setProperty('background-color', bg, 'important')
      tr.style.setProperty('background-color', bg, 'important')
    }
    td.appendChild(el)
    tr.appendChild(td)
    return tr
  }

  function renderCards() {
    // 작성·수정 중에는 다시 그리지 않는다. 다시 그리면 입력창이 든 줄까지 지워져 창이 사라진다.
    if (state.composer || document.querySelector('.dm-card textarea')) { state.pendingRefresh = true; return }

    // 전부 지우고 다시 그리면 파일을 여닫을 때마다 모든 카드가 깜빡인다.
    // 바뀐 것만 다시 그리고, 그대로인 카드는 DOM 에 둔 채 재사용한다.
    if (!state.cardByNote) { state.cardByNote = new Map() }
    const keep = new Set()
    state.cards = []

    // 들고 있던 줄이 하나라도 떨어져 나갔으면 그리기 전에 다시 훑는다.
    const stale = state.data.notes.some((n) => {
      const rows = state.rows.get(normPath(n.path))
      return rows && !rows.some((r) => r.el.isConnected)
    })
    if (stale) { scan() }

    const left = railLeft()
    const inline = window.innerWidth - left < MIN_RAIL
    const blocks = fileBlocks()
    const orphans = []
    const collapsed = new Map()
    const fileNotes = new Map()
    let lastBottom = 0

    const sorted = [...state.data.notes].sort((a, b) => {
      const ra = findRow(a); const rb = findRow(b)
      if (!ra || !rb) { return 0 }
      return ra.el.getBoundingClientRect().top - rb.el.getBoundingClientRect().top
    })

    for (const note of sorted) {
      // 줄 번호가 없거나 붙일 코드 문자열이 비었으면 파일에 단 메모다. 억지로 줄에 붙이면 엉뚱한 자리로 간다.
      if (!note.line || !note.lineText) {
        const key = normPath(note.path)
        if (!fileNotes.has(key)) { fileNotes.set(key, []) }
        fileNotes.get(key).push(note)
        continue
      }
      const row = findRow(note)
      if (!row) {
        const key = normPath(note.path)
        // 파일이 접혀 있으면 줄이 아예 없다. 메모를 잃어버린 게 아니므로 떠돌이로 보내지 않는다.
        if (blocks.has(key) && !state.rows.has(key)) {
          if (!collapsed.has(key)) { collapsed.set(key, []) }
          collapsed.get(key).push(note)
        } else if (blocks.has(key)) {
          // 파일은 그대로인데 그 줄만 사라졌다(대개 요청을 처리해 코드가 바뀐 경우).
          // 화면 맨 위로 보내면 어느 파일 얘기였는지 잃는다. 그 파일의 파일 메모로 내린다.
          if (!fileNotes.has(key)) { fileNotes.set(key, []) }
          fileNotes.get(key).push({ ...note, drifted: true })
        } else {
          orphans.push(note)
        }
        continue
      }
      const sig = `${JSON.stringify(note)}|${inline ? 'inline' : 'rail'}`
      const old = state.cardByNote.get(note.id)
      const reusable =
        old &&
        old.sig === sig &&
        old.rowEl === row.el &&
        old.el.isConnected &&
        (!old.wrapper || old.wrapper.previousElementSibling === row.el)

      if (reusable) {
        keep.add(note.id)
        state.cards.push({ el: old.el, note, line: old.line })
        if (!inline) {
          const rect = row.el.getBoundingClientRect()
          const top = Math.max(rect.top, lastBottom + 6)
          old.el.style.top = `${top}px`
          lastBottom = top + old.el.offsetHeight
        }
        continue
      }

      dropCard(note.id)

      // 메모 하나가 터져도 나머지는 그려야 한다. 전에 한 건 때문에 화면이 통째로 비었다.
      let el
      try {
        el = cardEl(note, row)
      } catch (err) {
        console.error('[diffmate] 카드 그리기 실패', note.id, err)
        continue
      }

      if (inline) {
        el.classList.add('dm-inline')
        const wrapper = wrapInlineRow(el, row)
        row.el.insertAdjacentElement('afterend', wrapper)
        state.cardByNote.set(note.id, { el, wrapper, rowEl: row.el, sig })
        keep.add(note.id)
        state.cards.push({ el, note })
        continue
      }

      document.body.appendChild(el)
      const rect = row.el.getBoundingClientRect()
      const top = Math.max(rect.top, lastBottom + 6)
      el.style.top = `${top}px`
      el.style.left = `${left + GAP}px`
      lastBottom = top + el.offsetHeight

      const line = document.createElement('div')
      line.className = 'dm-connector'
      line.style.top = `${rect.top + rect.height / 2}px`
      line.style.left = `${rect.right}px`
      line.style.width = `${Math.max(0, left + GAP - rect.right)}px`
      document.body.appendChild(line)

      state.cardByNote.set(note.id, { el, line, rowEl: row.el, sig })
      keep.add(note.id)
      state.cards.push({ el, note, line })
    }

    for (const id of [...state.cardByNote.keys()]) {
      if (!keep.has(id)) { dropCard(id) }
    }

    // 어디서 끊기는지 한 번에 보이게 — 파일별로 줄 수·메모 수·처리 결과.
    const report = {}
    for (const path of new Set([...Object.keys(state.data.files || {}), ...state.data.notes.map((n) => normPath(n.path))])) {
      const notes = state.data.notes.filter((n) => normPath(n.path) === path)
      report[path.split('/').slice(-2).join('/')] = {
        블록: blocks.has(path) ? 'O' : 'X',
        줄: (state.rows.get(path) || []).length,
        메모: notes.length,
        그림: state.cards.filter((c) => normPath(c.note.path) === path).length,
        접힘: (collapsed.get(path) || []).length,
        떠돌이: orphans.filter((n) => normPath(n.path) === path).length,
      }
    }
    const reportJson = JSON.stringify(report)
    if (reportJson !== state.lastReport) {
      state.lastReport = reportJson
      console.debug('[diffmate] 상태'); console.table(report)
    }

    renderFileNotes(fileNotes, blocks)
    renderCollapsedBadges(collapsed, blocks)
    renderOrphans(orphans)
  }

  function renderFileNotes(fileNotes, blocks) {
    const sig = JSON.stringify([...fileNotes].map(([k, v]) => [k, (state.rows.get(k) || []).length > 0, v.map((n) => n.id + n.status + (n.thread?.length || 0) + (n.answer || '') + n.body)]))
    const drawn = document.querySelectorAll('.dm-file-notes')
    if (sig === state.lastFileNoteSig && (drawn.length || !fileNotes.size)) { return }
    state.lastFileNoteSig = sig

    document.querySelectorAll('.dm-file-notes').forEach((el) => el.remove())
    for (const [path, notes] of fileNotes) {
      const banner = document.querySelector(`.dm-file-summary[data-dm-path="${CSS.escape(path)}"]`)
      const anchor = banner || (blocks.has(path) ? belowBar(path, blocks.get(path), blocks) : null)
      if (!anchor) { continue }
      const box = document.createElement('div')
      box.className = 'dm-file-notes'
      for (const note of notes) {
        try {
          box.appendChild(cardEl(note, { line: null, el: null }))
        } catch (err) {
          console.error('[diffmate] 카드 그리기 실패', note.id, err)
        }
      }
      if (banner) {
        banner.insertAdjacentElement('afterend', box)
      } else {
        anchor.appendChild(box)
      }
    }
  }

  function renderCollapsedBadges(collapsed, blocks) {
    const sig = JSON.stringify([...collapsed].map(([k, v]) => [k, (state.rows.get(k) || []).length > 0, v.map((n) => n.id + n.status)]))
    const drawn = document.querySelectorAll('.dm-stack')
    if (sig === state.lastCollapsedSig && (drawn.length || !collapsed.size)) { return }
    state.lastCollapsedSig = sig

    document.querySelectorAll('.dm-collapsed-badge, .dm-badge-row, .dm-stack').forEach((el) => el.remove())
    for (const [path, notes] of collapsed) {
      const block = blocks.get(path)
      if (!block) { continue }
      const bar = belowBar(path, block, blocks)

      const head = document.createElement('div')
      head.className = 'dm-badge-row'
      const badge = document.createElement('span')
      badge.className = 'dm-collapsed-badge'
      badge.appendChild(claudeIcon(14))
      const open = notes.filter((n) => n.status === 'open').length
      const label = document.createElement('span')
      label.textContent = open ? `메모 ${notes.length} · 미답변 ${open}` : `메모 ${notes.length}`
      badge.appendChild(label)
      badge.title = '눌러서 그 파일로'
      badge.style.cursor = 'pointer'
      badge.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation()
        const card = fileCard(block, blocks)
        const collapsedToggle = card.querySelector('button[aria-expanded="false"], [role="button"][aria-expanded="false"]')
        if (collapsedToggle) {
          collapsedToggle.click()
        } else {
          card.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
        setTimeout(() => refresh(true), 600)
      })
      head.appendChild(badge)
      bar.appendChild(head)

      // 줄을 못 찾았다고 메모를 숨기지 않는다. 카드를 여기에 그대로 펼친다.
      const stack = document.createElement('div')
      stack.className = 'dm-stack'
      for (const note of notes) {
        try {
          stack.appendChild(cardEl(note, { line: note.line, el: null }))
        } catch (err) {
          console.error('[diffmate] 카드 그리기 실패', note.id, err)
        }
      }
      bar.appendChild(stack)
    }
  }

  // 머리말을 눌러 여닫는 카드로 만든다.
  function makeCompact(card, openByDefault = false) {
    card.classList.add('dm-compact')
    if (openByDefault) { card.classList.add('dm-expanded') }
    const head = card.querySelector('.dm-card-head')
    if (!head || head.dataset.dmToggle === '1') { return }
    head.dataset.dmToggle = '1'
    head.style.cursor = 'pointer'
    head.addEventListener('click', (e) => {
      if (e.target.closest('button')) { return }
      card.classList.toggle('dm-expanded')
    })
  }

  function dropCard(id) {
    const old = state.cardByNote?.get(id)
    if (!old) { return }
    old.el?.remove()
    old.wrapper?.remove()
    old.line?.remove()
    state.cardByNote.delete(id)
  }

  function cardEl(note, row) {
    // 상태는 필드가 있느냐가 아니라 마지막에 누가 말했느냐로 가른다.
    // answer 없이 thread 로만 답이 들어온 메모가 계속 "답변 대기"로 보였다.
    const turns = note.thread || []
    const lastSpeaker = turns.length ? turns[turns.length - 1].by : (note.answer ? 'claude' : 'me')
    const answered = lastSpeaker === 'claude'

    const el = document.createElement('div')
    el.className = 'dm-card'
    el.addEventListener('keydown', (e) => e.stopPropagation())

    const head = document.createElement('div')
    head.className = 'dm-card-head'
    head.appendChild(claudeIcon(16))
    const kind = document.createElement('span')
    kind.className = 'dm-kind'
    kind.textContent = { question: '질문', request: '요청', memo: '메모' }[note.kind] || note.kind
    head.appendChild(kind)
    const where = document.createElement('span')
    where.textContent = row.line ? `L${row.line}` : '파일'
    head.appendChild(where)

    if (note.drifted) {
      const drift = document.createElement('span')
      drift.className = 'dm-from-view'
      drift.textContent = `L${note.line} 사라짐`
      drift.title = '코드가 바뀌어 원래 줄이 없어졌다. 이 파일의 메모로 내려왔다'
      head.appendChild(drift)
    }

    // 다른 화면(전체 diff ↔ 특정 커밋)에서 쓴 메모는 줄이 안 맞을 수 있다. 어디서 썼는지 알려준다.
    const noteView = note.view || 'all'
    if (noteView !== (state.ctx.view || 'all')) {
      const from = document.createElement('span')
      from.className = 'dm-from-view'
      from.textContent = noteView === 'all' ? '전체 diff에서 작성' : `${noteView.slice(0, 7)}에서 작성`
      head.appendChild(from)
    }
    const spacer = document.createElement('span')
    spacer.className = 'dm-spacer'
    head.appendChild(spacer)

    const body = document.createElement('div')
    body.className = 'dm-body'
    body.textContent = note.body

    const edit = iconButton('수정', () => startEdit())
    const del = iconButton('삭제', async () => {
      await api('DELETE', '/notes', { query: { repo: state.ctx.repo, pr: state.ctx.pr, id: note.id } })
      refresh(true)
    })
    head.append(edit, del)

    const isResolved = note.status === 'resolved'
    if (answered || isResolved) {
      head.appendChild(iconButton(isResolved ? '다시 열기' : '완료', async () => {
        await api('PATCH', '/notes', {
          query: { repo: state.ctx.repo, pr: state.ctx.pr },
          body: { id: note.id, status: isResolved ? 'answered' : 'resolved' },
        })
        refresh(true)
      }))
    }

    if (isResolved) {
      el.classList.add('dm-resolved')
      const check = document.createElement('span')
      check.className = 'dm-check'
      check.textContent = '✓'
      head.prepend(check)
      // 다 본 메모는 한 줄로 접어둔다. 머리말을 누르면 펼친다.
      head.style.cursor = 'pointer'
      head.addEventListener('click', (e) => {
        if (e.target.closest('button')) { return }
        el.classList.toggle('dm-expanded')
      })
    }

    el.append(head, body)

    if (note.answer) {
      const ans = document.createElement('div')
      ans.className = 'dm-answer'
      ans.textContent = note.answer
      el.appendChild(ans)
    }

    // '수정' 은 마지막으로 내가 쓴 것을 고친다. 그 자리를 여기서 기억해 둔다.
    let mineIndex = -1
    let mineEl = body
    turns.forEach((turn, i) => {
      const line = document.createElement('div')
      line.className = turn.by === 'me' ? 'dm-reply-mine' : 'dm-answer'
      line.textContent = turn.body
      el.appendChild(line)
      if (turn.by === 'me') { mineIndex = i; mineEl = line }
    })

    const waiting = note.kind !== 'memo' && !answered
    if (waiting) {
      const pending = document.createElement('div')
      pending.className = 'dm-pending'
      pending.textContent = '답변 대기'
      el.appendChild(pending)
    }

    if (answered) {
      const foot = document.createElement('div')
      foot.className = 'dm-actions dm-foot'
      foot.appendChild(button('답글', () => startReply()))
      el.appendChild(foot)
    }

    // 답을 보고 되묻는 자리. 답글을 달면 다시 미답변으로 돌아간다.
    function startReply() {
      if (el.querySelector('textarea')) { return }
      const ta = document.createElement('textarea')
      ta.placeholder = '그건 왜 그런데?'
      const actions = document.createElement('div')
      actions.className = 'dm-actions'
      const hint = document.createElement('span')
      hint.className = 'dm-hint'
      hint.textContent = '⌘Enter 저장'

      const close = () => { ta.remove(); actions.remove() }
      const commit = async () => {
        const text = ta.value.trim()
        if (!text) { return }
        close()
        const res = await api('PATCH', '/notes', {
          query: { repo: state.ctx.repo, pr: state.ctx.pr },
          body: { id: note.id, reply: text },
        })
        if (!res.ok) { flashStatus('답글 실패 — 데몬이 떠 있나?'); return }
        refresh(true)
      }

      actions.append(hint, button('취소', close), button('저장', commit, true))
      el.append(ta, actions)
      ta.focus()
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { close(); return }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit() }
      })
    }

    // 본문을 그 자리에서 고친다. 답변이 이미 달렸으면 고치는 순간 다시 미답변으로 돌아간다.
    function startEdit() {
      if (el.querySelector('textarea')) { return }
      const ta = document.createElement('textarea')
      ta.value = mineIndex >= 0 ? turns[mineIndex].body : note.body
      const actions = document.createElement('div')
      actions.className = 'dm-actions'
      const hint = document.createElement('span')
      hint.className = 'dm-hint'
      hint.textContent = '⌘Enter 저장'

      // 입력창이 떠 있는 동안에는 다시 그리기가 막혀 있다. 저장하든 취소하든 먼저 걷어야 화면이 갱신된다.
      const closeEdit = () => {
        ta.remove()
        actions.remove()
        mineEl.hidden = false
      }

      const commitEdit = async () => {
        const next = ta.value.trim()
        if (!next) { return }
        closeEdit()
        const payload = mineIndex >= 0
          ? { id: note.id, editReply: { index: mineIndex, body: next } }
          : { id: note.id, body: next }
        const res = await api('PATCH', '/notes', {
          query: { repo: state.ctx.repo, pr: state.ctx.pr },
          body: payload,
        })
        if (!res.ok) { flashStatus('수정 실패 — 데몬이 떠 있나?'); return }
        refresh(true)
      }

      actions.append(hint, button('취소', closeEdit), button('저장', commitEdit, true))
      mineEl.hidden = true
      mineEl.insertAdjacentElement('afterend', ta)
      ta.insertAdjacentElement('afterend', actions)
      ta.focus()
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeEdit(); return }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitEdit() }
      })
    }

    return el
  }

  function iconButton(label, onClick) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick() })
    return b
  }

  function renderOrphans(orphans) {
    document.querySelector('.dm-orphans')?.remove()
    if (!orphans.length) { return }

    const box = document.createElement('div')
    box.className = 'dm-orphans'
    const h = document.createElement('h4')
    h.textContent = `떠돌이 메모 ${orphans.length}개 — 이 화면에 그 파일이 없다`
    box.appendChild(h)

    for (const note of orphans) {
      const where = document.createElement('div')
      where.className = 'dm-orphan'
      where.innerHTML = `<code>${note.path}${note.line ? `:${note.line}` : ''}</code>`
      box.appendChild(where)

      // 읽기만 되면 여기서 아무것도 못 한다. 카드로 그려서 수정·삭제·완료를 그 자리에서 하게 한다.
      try {
        box.appendChild(cardEl(note, { line: note.line, el: null }))
      } catch (err) {
        console.error('[diffmate] 떠돌이 카드 그리기 실패', note.id, err)
      }
    }

    const anchor = document.querySelector('#files, .js-diff-progressive-container, main')
    anchor?.prepend(box)
  }

  // ── 파일 요약 배너 ─────────────────────────────────────
  // 접힌 파일은 블록이 헤더 줄 자체로 잡힌다. 그 안에 전체 폭 요소를 꽂으면 파일명이 밀려난다.
  // 그 파일만 담은 가장 바깥 요소까지 올라가서 그 아래에 붙인다.
  function fileCard(el, blocks) {
    let cur = el
    while (cur.parentElement && cur.parentElement !== document.body) {
      const parent = cur.parentElement
      let hasOther = false
      for (const other of blocks.values()) {
        if (other !== el && parent.contains(other)) { hasOther = true; break }
      }
      if (hasOther) { break }
      cur = parent
    }
    return cur
  }

  function belowBar(path, block, blocks) {
    const existing = document.querySelector(`.dm-below[data-dm-path="${CSS.escape(path)}"]`)
    if (existing) { return existing }
    const bar = document.createElement('div')
    bar.className = 'dm-below'
    bar.dataset.dmPath = path
    const card = fileCard(block, blocks)
    // 펼쳤을 때 요약이 파일명 바로 아래에 오므로, 접혔을 때도 아래에 붙여야 자리가 안 바뀐다.
    card.insertAdjacentElement('afterend', bar)
    // 카드 사이는 margin 일 수도 flex gap 일 수도 있다. 계산하지 말고 벌어진 픽셀을 직접 재서 당긴다.
    const gap = bar.getBoundingClientRect().top - card.getBoundingClientRect().bottom
    if (gap > 0 && gap < 80) { bar.style.marginTop = `${-gap}px` }
    return bar
  }

  // GitHub 파일 헤더는 화면에 붙박이로 고정된다. 그 안에 꽂으면 요약도 같이 고정돼
  // 코드가 그 밑으로 흘러가 버린다. 붙박이 영역을 찾아 그 바깥에 붙인다.
  function stickyAncestor(el, limit) {
    let cur = el
    let found = null
    while (cur && cur !== limit?.parentElement) {
      if (getComputedStyle(cur).position === 'sticky') { found = cur }
      cur = cur.parentElement
    }
    return found
  }

  function headerOf(block, path) {
    const base = path.split('/').pop()
    return (
      block.querySelector('.file-header, [class*="file-header"], header') ||
      [...block.children].find((c) => c.textContent?.includes(base) && !c.querySelector(ROW_SEL)) ||
      null
    )
  }

  function renderSummaries() {
    const blocks = fileBlocks()
    if (!state.summaryByPath) { state.summaryByPath = new Map() }
    const files = new Map(Object.entries(state.data.files || {}).map(([k, v]) => [normPath(k), v]))
    const missing = [...files.keys()].filter((p) => !blocks.has(p))
    if (missing.length) {
      // GitHub 은 아래쪽 파일을 스크롤할 때 붙인다. 스크롤해도 계속 남는 것만 진짜 문제다.
      console.debug('[diffmate] 아직 화면에 안 붙은 파일', missing.length, missing)
    }

    const keep = new Set()
    for (const [path, block] of blocks) {
      const info = files.get(path)
      if (!info?.summary) { continue }

      // 파일 하나가 바뀌었다고 전체를 다시 그리면 화면이 통째로 깜빡인다.
      // 그 파일의 내용과 붙을 자리가 그대로면 손대지 않는다.
      const hasRows = (state.rows.get(path) || []).length > 0
      const sig = `${JSON.stringify(info)}|${hasRows}`
      const old = state.summaryByPath.get(path)
      if (old && old.sig === sig && old.el.isConnected) {
        keep.add(path)
        continue
      }
      dropSummary(path)

      const banner = document.createElement('div')
      banner.className = 'dm-file-summary'
      banner.dataset.dmPath = path

      const logo = document.createElement('button')
      logo.className = 'dm-logo-btn'
      logo.type = 'button'
      logo.title = '이 파일 전체에 대해 묻는다. 줄에 묶이지 않는다'
      logo.appendChild(claudeIcon(20))
      logo.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation()
        openComposer({ line: null, el: banner }, path)
      })
      banner.appendChild(logo)
      if (info.risk) {
        const risk = document.createElement('span')
        risk.className = `dm-risk dm-risk-${info.risk}`
        risk.textContent = { high: '● 중요', mid: '● 보통', low: '○ 훑기' }[info.risk] || ''
        banner.appendChild(risk)
      }
      const text = document.createElement('span')
      text.textContent = info.summary
      banner.appendChild(text)


      // 헤더 옆에 붙이면 GitHub 의 붙박이 영역에 들어가 코드만 밑으로 흘러간다.
      // 코드 표의 첫 줄로 넣으면 구조상 붙박이가 될 수 없어 같이 스크롤된다.
      const firstRow = (state.rows.get(path) || [])[0]
      if (firstRow?.el?.isConnected && firstRow.el.tagName === 'TR') {
        const tr = document.createElement('tr')
        tr.className = 'dm-summary-row'
        const td = document.createElement('td')
        td.colSpan = firstRow.el.children.length || 3
        td.style.padding = '0'
        td.appendChild(banner)
        tr.appendChild(td)
        // 구간 머리말(@@ …) 도 표의 한 줄이다. 그 위, 표의 맨 첫 줄로 올린다.
        const firstTr = firstRow.el.parentElement?.firstElementChild || firstRow.el
        firstTr.insertAdjacentElement('beforebegin', tr)
        state.summaryByPath.set(path, { el: banner, wrapper: tr, sig })
      } else {
        belowBar(path, block, blocks).appendChild(banner)
        state.summaryByPath.set(path, { el: banner, sig })
      }
      keep.add(path)
    }

    for (const path of [...state.summaryByPath.keys()]) {
      if (!keep.has(path)) { dropSummary(path) }
    }
  }

  function dropSummary(path) {
    const old = state.summaryByPath?.get(path)
    if (!old) { return }
    old.el?.remove()
    old.wrapper?.remove()
    document.querySelector(`.dm-below[data-dm-path="${CSS.escape(path)}"]`)?.remove()
    state.summaryByPath.delete(path)
  }

  // ── 상태 표시 ──────────────────────────────────────────
  function renderStatus() {
    let pill = document.querySelector('.dm-status')
    if (!pill) {
      pill = document.createElement('div')
      pill.className = 'dm-status'
      document.body.appendChild(pill)
    }
    pill.textContent = ''
    pill.classList.toggle('dm-offline', state.offline)
    pill.appendChild(claudeIcon(20))
    const label = document.createElement('span')
    if (state.offline) {
      label.textContent = '데몬 꺼짐 — yarn notes'
    } else {
      const open = state.data.notes.filter((n) => n.status === 'open').length
      const files = Object.keys(state.data.files || {}).length
      label.textContent = `메모 ${state.data.notes.length} · 미답변 ${open}${files ? ` · 요약 ${files}` : ''}`
    }
    pill.appendChild(label)
  }

  function flashStatus(msg) {
    const pill = document.querySelector('.dm-status')
    if (!pill) { return }
    const prev = pill.textContent
    pill.textContent = msg
    setTimeout(() => { renderStatus() }, 2000)
  }

  // ── 새로고침 ───────────────────────────────────────────
  async function refresh(force = false) {
    if (!state.ctx) { return }
    // 작성 중에 다시 그리면 입력창이 통째로 날아간다. 닫힐 때까지 미룬다.
    if (state.composer || document.querySelector('.dm-card textarea')) { state.pendingRefresh = true; return }
    state.blocksCache = null
    const res = await api('GET', '/notes', { query: { repo: state.ctx.repo, pr: state.ctx.pr } })
    state.offline = !res.ok
    if (!res.ok) { renderStatus(); return }

    const json = JSON.stringify(res.data)
    if (!force && json === state.lastJson) { return }
    state.lastJson = json
    state.data = res.data

    await learnPaths([
      ...Object.keys(state.data.files || {}).map(normPath),
      ...state.data.notes.map((n) => normPath(n.path)),
      ...fileBlocks().keys(),
    ])

    scan()
    renderSummaries()
    renderCards()
    renderStatus()
  }

  function reposition() {
    if (state.composer || document.querySelector('.dm-card textarea')) { return }
    if (!state.cards.length) { return }
    const left = railLeft()
    if (window.innerWidth - left < MIN_RAIL) { renderCards(); return }
    let lastBottom = 0
    for (const { el, note, line } of state.cards) {
      const row = findRow(note)
      if (!row) { continue }
      const rect = row.el.getBoundingClientRect()
      const top = Math.max(rect.top, lastBottom + 6)
      el.style.top = `${top}px`
      el.style.left = `${left + GAP}px`
      lastBottom = top + el.offsetHeight
      if (line) {
        line.style.top = `${rect.top + rect.height / 2}px`
        line.style.left = `${rect.right}px`
        line.style.width = `${Math.max(0, left + GAP - rect.right)}px`
      }
    }
  }

  // ── 시작 ───────────────────────────────────────────────
  // GitHub 은 SPA 라 Conversation 에서 눌러 들어와도 페이지가 새로 뜨지 않는다.
  // 주입은 PR 화면 전체에 하고, 켜고 끄는 건 주소를 지켜보며 여기서 한다.
  function watchUrl() {
    let last = location.href
    const check = () => {
      if (location.href === last) { return }
      last = location.href
      const ctx = detectContext()
      console.debug('[diffmate] 주소 바뀜', location.pathname, '· 켬=', !!ctx)
      if (ctx) {
        state.ctx = ctx
        state.blocksCache = null
        state.lastJson = ''
        refresh(true)
        return
      }
      // 변경 화면을 떠났다 — 그려둔 것을 걷는다
      state.ctx = null
      document.querySelectorAll('[class^="dm-"], [class*=" dm-"]').forEach((el) => el.remove())
      state.cardByNote = new Map()
      state.summaryByPath = new Map()
      state.cards = []
    }
    // pushState 가로채기는 안 통한다 — 확장 스크립트는 페이지와 다른 자바스크립트 세계에 있어서
    // 여기서 바꾼 history 는 GitHub 이 부르는 것과 다른 객체다.
    window.addEventListener('popstate', () => setTimeout(check, 0))
    if (window.navigation) {
      window.navigation.addEventListener('navigatesuccess', () => setTimeout(check, 0))
    }
    setInterval(check, 400)
  }

  // GitHub 어느 페이지에서 출발하든 SPA 로 변경 화면에 닿을 수 있다. 그래서 주입은 전체에 받고,
  // 실제 일(듣기·감시·폴링)은 변경 화면에 처음 닿는 순간에만 한 번 붙인다.
  let activated = false

  function activate() {
    if (activated) { return }
    activated = true

    attachHover()

    let ticking = false
    const onMove = () => {
      if (ticking) { return }
      ticking = true
      requestAnimationFrame(() => {
        reposition()
        hoverBtn?.classList.remove('dm-visible')
        ticking = false
      })
    }
    window.addEventListener('scroll', onMove, { passive: true, capture: true })
    window.addEventListener('resize', () => { renderCards() })

    // GitHub 은 diff 를 나눠 붙이고 SPA 로 화면을 갈아끼운다. 조용해지면 다시 훑는다.
    // 내가 그린 것 목록. 여기서 빠진 클래스가 하나라도 있으면 렌더 → 감지 → 렌더로 무한히 돈다.
    const OURS = '[class^="dm-"], [class*=" dm-"]'
    let debounce = null
    new MutationObserver((records) => {
      if (!state.ctx) { return }
      const fromPage = records.some((r) => {
        const t = r.target
        if (t?.closest?.(OURS)) { return false }
        const nodes = [...r.addedNodes, ...r.removedNodes]
        if (nodes.length && nodes.every((n) => n.nodeType === 1 && n.closest?.(OURS))) { return false }
        return true
      })
      if (!fromPage) { return }
      clearTimeout(debounce)
      debounce = setTimeout(() => { state.blocksCache = null; refresh(true) }, 400)
    }).observe(document.body, { childList: true, subtree: true })

    setInterval(() => refresh(false), POLL_MS)
  }

  // 변경 화면인지 지켜본다. SPA 이동은 페이지가 새로 뜨지 않아 이 감시가 유일한 신호다.
  function watchUrl() {
    let last = location.href
    const check = () => {
      if (location.href === last) { return }
      last = location.href
      const ctx = detectContext()
      console.debug('[diffmate] 주소 바뀜', location.pathname, '· 켬=', !!ctx)
      if (ctx) {
        state.ctx = ctx
        state.blocksCache = null
        state.lastJson = ''
        activate()
        refresh(true)
        return
      }
      state.ctx = null
      document.querySelectorAll('[class^="dm-"], [class*=" dm-"]').forEach((el) => el.remove())
      state.cardByNote = new Map()
      state.summaryByPath = new Map()
      state.cards = []
    }
    window.addEventListener('popstate', () => setTimeout(check, 0))
    if (window.navigation) {
      window.navigation.addEventListener('navigatesuccess', () => setTimeout(check, 0))
    }
    setInterval(check, 400)
  }

  function boot() {
    console.debug('[diffmate] 주입됨', location.pathname, '· 변경화면=', location.pathname.includes('/changes'))
    watchUrl()

    const ctx = detectContext()
    if (!ctx) { return }
    state.ctx = ctx
    activate()
    refresh(true)
  }

  window.__diffmate = {
    state,
    refresh: () => refresh(true),
    probe() {
      const blocks = fileBlocks()
      const rows = scan()
      const out = {
        context: detectContext(),
        files: [...blocks.keys()],
        rowsPerFile: Object.fromEntries([...rows].map(([p, r]) => [p, r.length])),
        sampleRow: [...rows.values()][0]?.[0] || null,
      }
      console.log('[diffmate] probe', out)
      return out
    },
  }

  boot()
})()

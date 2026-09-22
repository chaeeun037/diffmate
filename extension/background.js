// content script 에서 직접 fetch 하면 페이지 CORS 에 걸린다. 네트워크는 전부 여기서 한다.
const PORT = 7777
const BASE = `http://127.0.0.1:${PORT}`

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const { method = 'GET', path = '/health', query = {}, body } = msg || {}
  const url = new URL(BASE + path)
  for (const [k, v] of Object.entries(query)) {
    if (v != null) { url.searchParams.set(k, v) }
  }

  fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
    .then(async (res) => sendResponse({ ok: res.ok, status: res.status, data: await res.json().catch(() => null) }))
    .catch((err) => sendResponse({ ok: false, offline: true, error: String(err?.message || err) }))

  return true
})

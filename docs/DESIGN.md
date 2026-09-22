# diffmate — PR diff 위에 에이전트에게 남기는 메모

기능은 둘이다. **① 파일별 한 줄 요약은 Claude가 쓴다. ② 줄 단위 질문은 사람이 쓰고 Claude가 답한다.**
둘 다 로컬 파일에만 쌓인다 — **GitHub에는 아무것도 올라가지 않는다.**

```
  ⓪ 작업 끝 → Claude가 파일별 한 줄 요약을 채운다
        │
        ▼
  [GitHub PR · Files changed]        파일 헤더 아래: "왜 바뀌었나" 한 줄
        │  ① 줄 옆 픽셀 에이전트 버튼 → 질문 작성
        ▼
   [크롬 익스텐션]  ──②──▶  로컬 데몬  ──▶  ~/.diffmate/<repo>/<pr>.json
        ▲                                        │ ▲
        │ ④ 오른쪽 여백에 답변 렌더               ▼ │ ③ "질문 답변 달아줘"
        └────────────────────────────  [AI 에이전트] ─┘

  ①~④는 여러 번 돈다. 답을 보고 또 물어도 같은 파일에 쌓인다.
```

## 정해진 것

| 항목 | 결정 | 이유 |
| --- | --- | --- |
| 익스텐션↔파일 다리 | 로컬 데몬 (`npm start`, 127.0.0.1:7777) | 실시간 양방향, 디버깅이 쉽다. 확장은 로컬 파일을 직접 못 읽는다 |
| 저장 위치 | `~/.diffmate/<owner>__<repo>/<pr>.json` | 레포별·PR별. 파일별로 쪼개지 않는다 — 답변 달 때 N개를 열게 된다 |
| 파일 요약 | 같은 JSON의 `files` 블록. Claude가 작업 직후에 채운다 | 질문과 같은 파일에 둬야 한쪽만 낡는 일이 없다 |
| 사이클 | 요약 → 질문 → 답변 → 다시 질문. 라운드 번호로 구분 | 답을 보고 또 묻는 게 기본 동작이다 |
| 메모 종류 | `question` 답만 단다 / `request` 코드를 고친다 / `memo` 손대지 않는다 | 저장 구조는 같고 Claude의 행동만 갈린다 |
| 버튼 | 픽셀 에이전트 (인라인 SVG) | GitHub 파란 `+`와 절대 안 헷갈린다. "에이전트한테 가는 메모"가 아이콘으로 읽힌다 |
| 카드 위치 | diff 오른쪽 여백, 줄과 선으로 연결 | 진짜 GitHub 코멘트와 자리가 안 겹친다. 폭이 모자라면 줄 아래 인라인으로 떨어진다 |
| 앵커 | `path` + 줄 내용 해시 + `commit` | 줄번호만 믿으면 새 커밋 하나에 메모 전부가 엉뚱한 줄로 간다 |
| 답변 반영 | 확장이 3초마다 폴링 | Claude가 JSON을 직접 고쳐도 새로고침 없이 뜬다 |

## 저장 형식

```jsonc
{
  "repo": "owner/repo",
  "pr": 123,
  "round": 1,                          // 답변 사이클. 답을 달 때마다 오른다
  "files": {                           // ① Claude가 쓴다
    "src/pages/_document.tsx": {
      "summary": "모든 페이지 HTML에 심는 측정 시작 신호. 첫 줄 경로 검사가 틀리면 전 페이지에서 로그가 나간다",
      "risk": "high",                  // high | mid | low
      "order": 1                       // 검수 권장 순서
    }
  },
  "notes": [                           // ② 사람이 쓰고 Claude가 답한다
    {
      "id": "n_lz1a",
      "kind": "question",              // question | request | memo
      "status": "open",                // open | answered | resolved
      "path": "src/pages/_document.tsx",
      "line": 41,                      // 작성 당시 줄번호 (힌트일 뿐)
      "endLine": null,                 // 구간 메모면 끝 줄
      "side": "RIGHT",                 // RIGHT=추가된 줄, LEFT=삭제된 줄
      "lineText": "<script ... />",    // 앵커 원문 (공백 정리본)
      "textHash": "a1b2c3d4",          // lineText 해시
      "commit": "abc123…",             // 작성 시점 head sha
      "body": "이거 서버에서도 도나?",
      "answer": null,
      "answeredAt": null,
      "createdAt": "2026-09-21T…"
    }
  ]
}
```

## 앵커가 밀렸을 때

1. 저장된 줄번호 자리의 코드가 `textHash`와 같으면 그대로 붙인다.
2. 다르면 같은 파일 안에서 `textHash`가 맞는 줄을 찾아 옮겨 붙인다.
3. 그래도 없으면 **떠돌이 메모**로 화면 맨 위 패널에 모은다. 지우지 않는다.

`request` 메모를 처리하면 그 줄이 바뀌어 2·3번으로 떨어진다. 그래서 Claude는 요청을 처리한 뒤
`line`·`lineText`·`textHash`를 새 코드 기준으로 갱신하고, 답에 무엇이 어떻게 바뀌었는지 적는다.

## 구성요소

- `daemon/server.mjs` — 데몬. JSON을 매 요청마다 디스크에서 읽고 쓴다(Claude의 직접 수정이 바로 보이게).
- `extension/` — MV3. content script가 diff DOM에 버튼·카드를 얹고, 네트워크는 background가 맡는다
  (content script에서 직접 fetch하면 페이지 CORS에 걸린다).
- `AGENTS.md` — AI 에이전트 쪽 절차. 메모를 읽고 종류별로 처리한 뒤 답을 같은 자리에 쓴다.

## 아직 안 정한 것

- GitHub `Files changed` DOM은 개편을 탄다. 선택자를 못 찾으면 콘솔에 `__diffmate.probe()` 결과를 찍게 해뒀다.
- 여러 PR을 동시에 열어두는 경우의 데몬 동시 쓰기. 지금은 마지막 쓰기가 이긴다.

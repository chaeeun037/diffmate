# diffmate

GitHub PR의 `Files changed` 화면 위에 **자기만 보는 메모**를 달고, AI 에이전트가 **같은 자리에 답하게** 하는 크롬 확장.

GitHub에는 아무것도 올라가지 않는다. 메모는 전부 내 컴퓨터에만 있고, 다른 사람이 같은 PR을 열어도 아무것도 안 보인다.

```
  ⓪ 에이전트가 파일별 한 줄 요약을 채운다
        │
        ▼
  [GitHub PR · Files changed]     파일 이름 아래: 이 파일을 왜 봐야 하는지
        │  ① 줄 옆 버튼 → 질문 작성
        ▼
   [크롬 확장]  ──②──▶  로컬 데몬  ──▶  ~/.diffmate/<owner>__<repo>/<pr>.json
        ▲                                   │ ▲
        │ ④ 답이 같은 자리에 뜬다            ▼ │ ③ 에이전트에게 "답변 달아줘"
        └───────────────────────  [AI 에이전트] ─┘

  ①~④는 여러 번 돈다. 답을 보고 또 물으면 같은 카드에 쌓인다.
```

## 왜 만들었나

AI가 쓴 코드를 사람이 검수할 때, diff만 봐서는 **어느 파일을 왜 봐야 하는지**가 안 보인다.
그렇다고 PR 본문에 길게 쓰면 정작 코드를 볼 때는 화면 위쪽 멀리 있어서 아무도 안 읽는다.

그래서 설명을 diff 옆으로 가져왔다. 그리고 방향을 뒤집었다 — 에이전트가 설명을 미는 게 아니라,
**모르는 사람이 묻고 아는 쪽이 답한다.** 무엇을 모르는지는 읽는 사람만 안다.

## 설치

```bash
git clone https://github.com/<you>/diffmate.git
cd diffmate
npm start          # 로컬 데몬 (127.0.0.1:7777)
```

크롬에서 `chrome://extensions` → 개발자 모드 켜기 → **압축해제된 확장 프로그램을 로드** → `extension/` 폴더 선택.

Node 18 이상이면 되고, 의존성은 없다.

## 쓰는 법

**메모 달기** — diff 줄에 마우스를 올리면 줄번호 왼쪽에 버튼이 뜬다. 누르고 쓰면 된다.

- `⌘Enter` 저장 · `Esc` 취소
- 종류 세 가지: `질문`(답만) · `요청`(코드를 고쳐달라) · `메모`(에이전트가 안 건드림)
- 파일 이름 아래 요약 배너의 로고를 누르면 **줄에 묶이지 않는 파일 단위 메모**가 된다

**답 받기** — 에이전트에게 "메모 답변 달아줘"라고 한다. 아래 CLI로 읽고 쓴다.

```bash
node cli/notes.mjs list                          # 어느 PR에 미답변이 남았나
node cli/notes.mjs list <owner/repo> <pr>        # 메모 전문 (JSON)
echo '답변' | node cli/notes.mjs answer <owner/repo> <pr> <noteId>
echo '답글' | node cli/notes.mjs reply  <owner/repo> <pr> <noteId>
```

**파일 요약 채우기** — 작업이 끝난 직후 에이전트가 채운다. 검수자가 diff를 열었을 때 첫 화면이 된다.

```bash
echo '{
  "src/pages/_document.tsx": {
    "summary": "모든 페이지 HTML에 심는 측정 시작 신호. 첫 줄 경로 검사가 틀리면 전 페이지에서 로그가 나간다.",
    "risk": "high", "order": 1
  }
}' | node cli/notes.mjs summarize <owner/repo> <pr>
```

요약을 어떻게 쓰는지는 [스킬](../../skill/ko/diffmate/SKILL.md)에 규칙으로 정리해뒀다.

## Claude Code 에서 쓰기

이 레포에 스킬이 들어 있다. Claude Code 가 스킬을 찾는 자리로 복사한다.

```bash
cp -r skill/ko/diffmate ~/.claude/skills/
```

스킬 안의 `DIFFMATE` 를 클론 경로로 맞춘 뒤, PR 을 올리고 "파일 요약 채워줘",
검수하면서 "메모 답변 달아줘" 라고 하면 된다.

## 저장되는 것

```
~/.diffmate/
  <owner>__<repo>/
    <pr>.json
```

레포별·PR별로 갈린다. 한 파일 안에 파일 요약(`files`)과 메모(`notes`)가 같이 들어간다.
메모는 `줄 번호 + 그 줄 내용의 해시`로 고정돼서, 새 커밋으로 줄이 밀려도 제자리를 찾는다.
못 찾으면 사라지지 않고 "떠돌이 메모"로 화면 위에 모인다.

## 알아둘 것

- **통합 보기(unified) 기준**이다. 나란히 보기(split)는 아직 안 맞춘다.
- GitHub의 `Files changed` DOM 위에 얹히므로 **화면이 개편되면 깨질 수 있다.** 버튼이 안 뜨면
  콘솔의 `[diffmate]` 로그를 보면 어디서 끊겼는지 나온다.
- 파일이 접혀 있으면(`Viewed` 체크) 그 파일의 diff 줄이 화면에 없다. 메모는 사라지지 않고
  파일 이름 아래에 펼쳐진다.
- 같은 PR을 두 탭에서 열고 동시에 쓰면 마지막 쓰기가 이긴다.

## 설계

자세한 구조와 그렇게 만든 이유는 [docs/DESIGN.md](docs/DESIGN.md)에 있다.

## AI 사용

이 레포는 AI(Claude Code)와 함께 만들고 메인테이너가 검토한다. 코드·문서·커밋 메시지 대부분이
에이전트 초안에서 출발했고, 모든 변경은 사람이 읽고 돌려보고 남기거나 다시 썼다.

AI 도구로 만든 기여도 환영한다. PR 에 그 사실을 적어주면 된다 — 이 레포는 `Assisted-by:` 트레일러를
쓴다. 대신 제출한 줄은 전부 설명할 수 있어야 한다.

## 라이선스

MIT

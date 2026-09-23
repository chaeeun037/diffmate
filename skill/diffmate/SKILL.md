---
name: diffmate
description: Review notes on a GitHub PR diff — fill in one-line summaries per changed file, and answer the questions the reviewer leaves on specific lines. Load this right after opening a pull request, and whenever the user says something like "answer my notes", "fill in the file summaries", or "review notes".
---

# diffmate

The reviewer reads the diff on GitHub and leaves notes on lines; you answer in the same place.
Notes never touch GitHub — they live in a local JSON file, one per pull request.

```
~/.diffmate/<owner>__<repo>/<pr>.json
```

Everything goes through the CLI. **Do not edit the JSON by hand** — the reviewer may be writing a note
at that moment, and a whole-file write would drop it.

Set `DIFFMATE` to wherever the repository is cloned:

```bash
DIFFMATE=~/diffmate          # adjust to your checkout
node $DIFFMATE/cli/notes.mjs list
```

## 1. Right after opening a pull request

Do these two together, and do not wait for them:

```bash
npm --prefix $DIFFMATE run check   # 0 = daemon up, 1 = down
```

If it is down, start `npm --prefix $DIFFMATE start` as a background process. Then fill in the file
summaries. The store path needs the PR number, so this can only run once the PR exists. The extension
re-reads every three seconds, so a late arrival still shows up while the reviewer is opening the page.

Summaries are recorded even when the daemon is down — the CLI writes the file directly. The daemon is
only needed for the extension to read it.

When a later commit adds files, fill in the ones still missing a summary during the next answering round.

## 2. Writing a file summary

The goal is not to explain the change — it is to show **what breaks if this is wrong**.
What changed is already in the diff.

```
[role label]. If [the place to look] is [wrong state], [consequence].
```

1. **Role label** — the job this file does *in this pull request*, not its general purpose. A short noun phrase.
2. **The if-wrong sentence** — state it positively. At most one negation. No em dashes.
3. **One line = one thing to check.** Keep it within a single screen line. If it overflows, drop the reasoning, not the check.
4. **Line count = the number of distinct ways this file can break.** Three at most. Do not pad with
   justification, and do not squeeze a wide-ranging file into one line either — that turns into
   "everything lives here", which points at nothing.
5. **A trade-off goes last, as `Decision: [what was chosen]. [what it cost].`** Write the cost, not the reason.
   A reason persuades; a cost can be reviewed.
6. **Each banner stands alone.** No "same as above" — GitHub orders files by path, so reading order is not guaranteed.

### Choosing what to flag

In order: what you could not run → what fails silently, with no error, type check or test → what spreads
beyond this file.

**If the code already guards against it, it is not a thing to check.** Drop it from the list —
open the code at that spot and look for the guard *before* listing a check. Skip that and you invent
plausible risks (it happened twice).
**If no if-wrong sentence can be written, lower the risk to `low` and write the label alone.** That is the
default, not an escape hatch. "I could not run this" is worth more than an invented risk.

### Risk

Sort by **how far it spreads when wrong** — not by file size or line count.

| Value | Meaning |
| --- | --- |
| `high` | It spreads past this feature, or invalidates the whole measurement or data set. Three per pull request at most |
| `mid` | Only the part this file owns goes wrong |
| `low` | An if-wrong sentence would have to be invented. Label only |

About half should end up `low`. If everything is a warning, nothing is.

### Plain words

**The test: would someone who did not build this understand it?** If not, write it again.
Vocabulary that only made sense while you were working will not survive a month, even for the author.

- **Do not use abbreviations or internal jargon at all.** Spelling them out in parentheses is the second
  choice — look for a plain word first.
- **Name code identifiers only when necessary**, and say what they are when you do. The names are already in the diff.
  `Added onAdSettled` → `Where the signal for "the ad actually landed" was added`.
- **Use the value and its meaning instead of a constant's name.** `TIMEOUT_MS` → "if it does not arrive within five seconds".

### Do not write

Reassurance ("this is intended", "guarded here") · justification ("I deferred it because…") ·
a list of risks you already handled · vague pointers with no location ("core logic", "needs attention") ·
remarks about size ("just one line" — the diff shows that).

### When rules collide

Accuracy beats brevity, but fix it by cutting the reasoning, not by adding a line ·
a consistent shape beats a natural sentence · a decision outranks a check for the last line.
More than four things to check is a sign the file or the pull request should be split.

### Recording them

```bash
echo '{
  "src/pages/_document.tsx": {
    "summary": "Inline beacon injected into every page. If the path check on the first line is wrong, every page fires the log.",
    "risk": "high", "order": 1
  }
}' | node $DIFFMATE/cli/notes.mjs summarize <owner/repo> <pr>
```

`order` is the suggested reading order. GitHub sorts by path, so the riskiest file often sits at the bottom.
Give every changed file a summary.

## 3. Answering notes

```bash
node $DIFFMATE/cli/notes.mjs list                    # which pull requests have unanswered notes
node $DIFFMATE/cli/notes.mjs list <owner/repo> <pr>  # the notes themselves
```

Handle only the ones with `status: "open"`.

### Read the spot before answering

Every note carries `path`, `line` and `lineText`. **Open the code with those three, then answer.**

1. Read that file's **summary** (the `files` block) — the answer is sometimes already written there
2. Read the code around `line`; for a file-level note, read the part of the file it concerns
3. Only then write the answer

Skip this and you answer the question from general knowledge, which reads plausibly while missing the
spot it was asked about. Two real cases: an answer that ignored the summary two lines above it, and a
risk invented for code that already guarded against it. Nothing breaks — the answers just get quietly
worse, which is why it goes unnoticed.

| kind | What you do |
| --- | --- |
| `question` | Answer. **Do not touch the code.** |
| `request` | Find every place that has to change first. Once it is done, **write in the answer what you changed and how**, then move the anchor as in §5, since that line has shifted. **If someone else makes the change, ask them to move the anchor too** — leave that out and the note loses its line. |
| `memo` | Leave it alone. |

```bash
echo 'It does not. _document is only rendered to a string on the server.' \
  | node $DIFFMATE/cli/notes.mjs answer <owner/repo> <pr> <noteId>
```

- **Keep the card about the code.** Two things keep leaking in.
  - *Your own workflow* — role names, handoff numbers, ticket states. The reader does not know that
    structure and has no reason to. Say **what changes**, not who you passed it to; one clause covers
    the handoff if it matters.
  - *Tool bookkeeping* — that you moved a note, lost its line, or normalised the store. **The screen
    already shows that.** A moved card sits where it moved to and carries a marker. Saying it again in
    prose pushes the code out of the way.
- The card is narrow. **Three sentences at most**; past that, point at a file instead.
- If you do not know, say so, and say what would settle it.
- If the question rests on a wrong premise, correct the premise first.

## 4. Follow-ups

When the reviewer replies, the note goes back to `status: "open"` and a `by: "me"` entry lands in `thread`.
**Do not overwrite `answer`** — continue the thread instead, or the reader loses what was asked.

```bash
echo '<follow-up answer>' | node $DIFFMATE/cli/notes.mjs reply <owner/repo> <pr> <noteId>
```

The rule is simple: if the last entry in `thread` is `me`, it is your turn.

## 5. When the code moved, or a note drifted

Handling a `request` shifts the line it was anchored to, so the note ends up on the wrong line or
falls out as an orphan. Re-anchor it against the new line.

```bash
echo '<the new line content>' | node $DIFFMATE/cli/notes.mjs reanchor <owner/repo> <pr> <noteId> <new line>
node $DIFFMATE/cli/notes.mjs move <owner/repo> <pr> <noteId> <new path>
node $DIFFMATE/cli/notes.mjs normalize <owner/repo> <pr>
```

`move` relocates a note (it drops the line anchor and becomes a file-level note).
`normalize` brings a store written by an older version in line: no line number means a file-level note,
otherwise the anchor hash is recomputed.

## 6. Finishing

Report **one line** — `answered N · applied M`. Do not restate the answers in chat; the reviewer reads them on the page.

---

## Appendix — writing summaries in Korean

The plain-words rule applies the same way, but the failure mode is more specific: loanwords and
in-house shorthand read as fluent while carrying no meaning.

| Instead of | Write |
| --- | --- |
| 인라인 비콘 | 모든 페이지의 HTML에 심는 '측정 시작' 신호 |
| 분모가 샌다 | 그 사용자는 통계에서 통째로 사라진다 |
| no-op 이다 | 아무것도 하지 않는다 |
| SPA로 들어온 세션 | 새로고침 없이 들어온 방문 |
| 마운트 직후 터진다 | 화면에 붙자마자 울린다 |

Do not use Chinese, Japanese or Hanja characters — the same bar as user-facing copy.

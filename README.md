# diffmate

**[See what it looks like →](https://chaeeun037.github.io/diffmate/)**

Leave **private notes** on a GitHub pull request diff, and have an **AI agent answer them in place**.

Nothing is posted to GitHub. Notes live on your machine only — nobody else sees them, even on the same PR.

```
  ⓪ the agent fills in a one-line summary per file
        │
        ▼
  [GitHub PR · Files changed]   under each filename: why this file is worth looking at
        │  ① click the gutter button → write a question
        ▼
   [extension]  ──②──▶  local daemon  ──▶  ~/.diffmate/<owner>__<repo>/<pr>.json
        ▲                                      │ ▲
        │ ④ the answer appears in place        ▼ │ ③ ask your agent to answer
        └──────────────────────────  [AI agent] ─┘

  ①~④ repeat. Follow-ups stack on the same card.
```

## Why

Reviewing AI-written code from a diff alone is hard: you cannot tell **which file matters and why**.
Writing it up in the PR description does not help either — by the time you are reading code, that text is far above the fold.

So the explanation moves next to the diff. And the direction flips: instead of the agent pushing context,
**the person who does not know asks, and the one who knows answers.** Only the reader knows what they are missing.

## Install

```bash
git clone https://github.com/chaeeun037/diffmate.git
cd diffmate
npm start          # local daemon on 127.0.0.1:7777
```

Then in Chrome: `chrome://extensions` → enable Developer mode → **Load unpacked** → pick `extension/`.

Node 18+. No dependencies.

## Use

**Leave a note** — hover a diff line; a button appears left of the line number. Click and type.

- `⌘Enter` to save, `Esc` to cancel
- Three kinds: `question` (answer only), `request` (change the code), `memo` (agent leaves it alone)
- Clicking the logo in a file's summary banner creates a **file-level note** that is not tied to any line

**Get answers** — ask your agent to answer the notes. It reads and writes through the CLI:

```bash
node cli/notes.mjs list                          # which PRs have unanswered notes
node cli/notes.mjs list <owner/repo> <pr>        # full notes as JSON
echo 'answer'   | node cli/notes.mjs answer <owner/repo> <pr> <noteId>
echo 'follow-up'| node cli/notes.mjs reply  <owner/repo> <pr> <noteId>
```

**Fill file summaries** — right after opening a PR, so the reviewer sees them first:

```bash
echo '{
  "src/pages/_document.tsx": {
    "summary": "Inline beacon injected into every page. If the path check on the first line is wrong, every page fires the log.",
    "risk": "high", "order": 1
  }
}' | node cli/notes.mjs summarize <owner/repo> <pr>
```

How to write those summaries is a discipline of its own — see the skill below.

## Use with Claude Code

A ready-made skill lives in this repo. Copy it where Claude Code looks for skills:

```bash
cp -r skill/diffmate ~/.claude/skills/        # English
cp -r skill/ko/diffmate ~/.claude/skills/     # Korean
```

Then set `DIFFMATE` to your checkout inside the skill, and ask your agent to
"fill in the file summaries" after opening a PR, or "answer my notes" while reviewing.

## Where notes live

```
~/.diffmate/
  <owner>__<repo>/
    <pr>.json
```

One file per PR, holding both the file summaries (`files`) and the notes (`notes`).
A note is anchored by **line number plus a hash of that line's content**, so it follows the code when a new commit shifts it.
When it cannot be found, it is not dropped — it surfaces as an "orphan note" at the top of the page.

## Good to know

- Built for **unified diff view**. Split view is not handled yet.
- It rides on GitHub's `Files changed` DOM, so **a redesign can break it.** If buttons stop appearing,
  the `[diffmate]` console logs say where it lost track.
- A collapsed file (marked `Viewed`) has no diff lines on the page. Its notes are not hidden —
  they expand under the filename instead.
- Two tabs on the same PR: last write wins.

## Docs

- [Korean README](docs/ko/README.md)
- [Agent skill](skill/diffmate/SKILL.md) — how the agent writes summaries and answers
- [Design notes](docs/ko/DESIGN.md) — structure and the reasoning behind it (Korean)

## AI use

This repo is developed with AI assistance (Claude Code), reviewed by the maintainer — most of the
code, docs and commit messages started as drafts from an agent, and every change was read, tested
and kept or rewritten by a person.

Contributions made with AI tools are welcome too. Please mention it in your pull request — an
`Assisted-by:` trailer is the convention this repo follows — and make sure you can explain every
line you submit.

## License

MIT

---

Issues in Korean or English are both welcome.

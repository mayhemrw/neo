# Phase 6: Word round-trip (plan, decisions, progress)

Temporary working file for the `word-roundtrip` branch. It's deleted from the branch before the merge into `main`; its contents live on in the claude.ai Project ("Scribe's Log": `claude/Phase 6 Plan.md` and `claude/Phase 6 Progress.md`). Planned Oct 9, 2026, 7:30 AM PT, while Ryan was away from his PC with only his phone.

## The approach in one paragraph

The writer sends the book to an editor as a Word file (**File → Export → Word for an Editor…**), and NEO names a version of the book at that moment ("Sent to Dana (Oct 9)") and hides a round id inside the .docx. When the editor's file comes back, **File → Import Review…** reads Word's tracked changes and comments, matches the file to the version it was sent from, and keeps everything in a new sidecar, `review.json`. Nothing touches the chapters at import. The writer opens a **Review** view (separate from the writing page, which never shows markup), sees each change as a suggestion in the reviewer's color, and accepts or rejects them one at a time, by reviewer, or all at once. Comments sit in the Review view's margin as threads; the writer replies or resolves, and the replies go back to the editor as real Word replies on the next export. Every accepted change is written to the Scribe's Log as the editor's (a new `src: 'editor'` with the reviewer's name), so the record tells the writer's words from the editor's.

## What the writer sees

- **Sending:** File → Export → Word for an Editor… asks for the editor's name (remembered per book, a short list to pick from), then saves the .docx in NEO's regular Word layout (decision 4) with the comment threads (open, and resolved ones marked done) and the writer's replies. The version "Sent to Dana (Oct 9)" shows in Chapter History like any named version.
- **Bringing it back:** File → Import Review… (or a .docx dropped on the open book's page) picks the file, says what it found ("Dana: 212 changes, 31 comments, 4 changes made without Track Changes"), and opens the Review view. A file that's not from NEO, or from a round it can't find, can still be imported: NEO asks which version it was sent from, defaulting to the closest by text.
- **The Review view** (View → Review, also in Ctrl+K; it appears as a tab only while the book has open suggestions or comments):
  - The book read-only, with each suggestion inline: insertions underlined, deletions struck, in the reviewer's color. Moves show as one suggestion.
  - A list of suggestions on the left (by chapter), comments in the right margin beside their text.
  - Accept and Reject on each (keys A and R, J and K to step), and for a reviewer, a chapter, or all. Accept All names a version first, like Replace All.
  - A reviewer filter (chips with each reviewer's color; one, several or all).
  - Changes made without Track Changes are found by comparing the file with the version it was sent from, and shown as suggestions marked "untracked".
  - A suggestion whose passage the writer has rewritten since is marked "out of date" and shows the editor's wording beside today's; the writer can still apply it by hand.
  - Two reviewers who changed the same passage (parallel rounds) show side by side; the writer picks one, or writes their own.
  - A file passed from one editor to the next (sequential rounds) keeps each person's changes under their own name, as Word stamped them.
- **Comments:** threads with replies, as Word had them. The writer replies (typed in NEO), resolves, or resolves and deletes (decision 6). Resolved threads fold up in the margin and go back to the editor marked done; deleted ones move to "Deleted comments".
- **The writing page** never shows any of this. A small count in the Review tab's label is the only sign there's something waiting.

## Under the hood

| Piece | Where |
|---|---|
| Reading Word's review markup: `w:ins`, `w:del`, `w:moveFrom`/`w:moveTo`, `w:rPrChange`/`w:pPrChange`, `comments.xml`, `commentsExtended.xml` (replies, done), `commentsIds.xml`, `people.xml`. A DOM-free XML tokenizer, not regexes over `<w:p>`. Gives each paragraph two texts (as the editor left it, and before their changes) plus the change spans and comment ranges. | new `review-docx.js` (plain JS, runs in Node and the browser) |
| Writing the review export: NEO's regular Word export (`buildDocxEntries`, decision 4) plus `docProps/custom.xml` (the round id, `NEO.ReviewRound`), a hidden bookmark at each chapter start (`_NEO_ch_<n>`), `w14:paraId` on paragraphs, and the comment parts for threads going back. | `app.js` DOCX section (options), `review-docx.js` |
| Matching an import to its version: by the round id, else by the writer's choice. Chapters by bookmark, else by heading, else by text. Paragraphs matched with `SlogDiff.compare`'s paragraph matcher. Untracked changes: the "before" text compared with the version's text. | `review-match.js` (plain JS) |
| `review.json` (book folder, through `json:write`): `rounds` (id, sent at, to whom, version ref, files imported), `reviewers` (name, color), `suggestions` (id, round, reviewer, chapter, anchor, kind, del, ins, untracked, date, status), `threads` (id, round, chapter, anchor, comments [{by, at, text}], resolved). Anchors are text quotes (exact plus 32 characters each side, and a paragraph hint), found again in today's text whenever shown. | `app.js` REVIEW section |
| Copies of the reviewed files: `reviews/<round>-<reviewer>.docx` in the book folder (decision 5), through a new `review:` IPC with `libName()`. Daily backup zips them with the book; Duplicate leaves them. | `main.js`, `preload.js` |
| The Scribe's Log: `src: 'editor'` (with `by`, the reviewer's name, decision 2) on accepted text; `cause: 'review'`. Added to `WINDOW_SRC`, `SLOG-FORMAT.md`, the checker's origins, the report's categories (a new "From an editor" line), playback's labels, the verifier's wording, and their tests. `review.json`'s own writes: comment text from the file as `import`, the writer's replies as `typed`. | `slog.js`, `slog-verify.js`, `slog-report.js`, `slog-playback.js`, `verifier/check.js` |
| Accepting goes through NEO's own text change for that paragraph (one `snapshotStructure('review')` per click, `slogWith({ src: 'editor', by, cause: 'review' })`), so Ctrl+Z works and nothing logs as `unlogged`. | `app.js` |
| Menus: File → Export → Word for an Editor…, File → Import Review…, View → Review (a free shortcut; Ctrl+Shift+R is taken by Align Right). | `main.js` |

## Decisions (defaults taken so work can start; answer from your phone)

Reply with the number and letter to change one ("2b, 7b"), or "defaults fine".

1. **The Review view:** **Ryan chose (a), Oct 9:** a tab beside Manuscript, Notes and the rest, shown only while there's something to review.
2. **Reviewer names in the Scribe's Log:** **Ryan accepted this for now (Oct 9, 8:19 AM); he'll ask beta testers how they'd want it handled, so keep it easy to change (the name handling in one place):** accepted editor text is *always* logged as `src: 'editor'` (that part isn't optional: logging it as typed would make the record say the writer typed words they didn't, and would let any text arrive through a made-up "editor's" file unseen). But the log carries **no names**: `by` is "Reviewer 1", "Reviewer 2" (numbered per book in order of first import; the number-to-name map lives only in `review.json`, which no export or report reads by default). The report and verifier say "From an editor (Reviewer 1)". The Verification Report dialog gets one more choice, **Name the editors** (off by default), which puts the names from `review.json` into that report only, never into the log or an export.
3. **Formatting-only changes:** **Ryan chose (b), Oct 9:** shown as suggestions like text changes (`kind: 'format'`, as M3 already keeps them), accepted or rejected one by one or in bulk; nothing applied at import, so no version at import.
4. **What goes to the editor:** **Ryan chose (b), Oct 9: NEO's regular Word layout** (the existing Word export, `buildDocxEntries` in app.js), not manuscript format.
5. **A copy of each reviewed .docx in the book folder** (`reviews/`): (a) yes, so a file can be read again later *(default)*; (b) no.
6. **Resolved comment threads on the next export:** **Ryan chose (b), Oct 9: sent back marked done.** And two buttons on every thread: **Resolve** (marked done, kept, goes back to the editor marked done) and **Resolve and Delete** (gone from the margin and from every later export). Words are never lost: a deleted thread moves to a "Deleted comments" list at the bottom of the Review view's margin, where it can be put back, and Ctrl+Z undoes it; the toast says where it went.
7. **Pocket:** (a) desktop only for now; Pocket's bridge has no history, which the round-trip needs *(default)*; (b) reading and replying to comments on Pocket too (a later phase).
8. **Accept All:** (a) names a version first, like Replace All *(default)*; (b) no version, Ctrl+Z only.

## Working while Ryan is on his phone

- **Builder sessions** run on a schedule, each in a fresh session (so no one conversation fills up), one milestone at a time, on the `word-roundtrip` branch. Each one pushes its work and ends by sending Ryan a short report: what's done, what's next, any question, and pictures (screenshots of the Review view from the e2e runs, the .docx pages rendered by LibreOffice). Everything is readable on a phone; nothing needs the PC.
- **Questions** never block: a builder takes the default, writes the question into "Open questions" below, and carries on. Ryan answers in any session's chat (or the planning chat); whoever reads the answer writes it into this file.
- **Optional phone task (helps the tests a lot):** after M2, a builder sends a small sample "for review" .docx (public-domain text, not Ryan's writing). If Word is on Ryan's phone: open it, Review → Track Changes on, change a few words, delete a sentence, add two comments and reply to one, save, and attach it back in any of these chats. It becomes a real-Word fixture in `scripts/fixtures/review/`.
- **The PC check** (real Word on Windows, a real two-way trip with Ryan as the editor) waits until he's back; M7 writes the steps.
- **Merging** waits for Ryan to say so.

## Milestones

Each is about one builder session. Every milestone ends with `npm test`, `npm run lint` at baseline (31), the e2e suites it touches, this file updated, pushed, and a phone report.

1. **M1: Reading Word's markup.** `review-docx.js` and its tests on fixtures: hand-written OOXML (every change type, comments with replies and done, people.xml, moves, nested formatting, a change inside a comment range), plus one made by LibreOffice (`soffice` with change tracking, as an outside tool, like screenplain's .fdx). The import's existing reader keeps working.
2. **M2: Sending.** File → Export → Word for an Editor…: the editor's name, the named version (`auto: 'word'`, the hook main.js already mentions), the round id, chapter bookmarks, paragraph ids; `review.json`'s rounds. Round-trip test: export, edit the XML as a reviewer would, read it back. The sample file for Ryan's phone task.
3. **M3: Bringing it back.** File → Import Review… and dropping on the open book; matching (`review-match.js`); untracked changes; formatting changes per decision 3; `reviews/` copies; the summary. Unit tests on matching (chapters reordered, a chapter renamed, text edited since sending).
4. **M4: The Review view and the log.** The tab, inline suggestions in colors, the list, accept and reject (single, by reviewer, chapter, all), out-of-date suggestions, Ctrl+Z. `src: 'editor'` through the log, checker, report, playback and verifier. e2e: import a fixture, accept and reject, check the log has no `unlogged` and the report counts editor text.
5. **M5: Comments.** Margin threads, reply, resolve; threads exported back as Word replies (`commentsExtended.xml`'s `paraIdParent`); a second round reads them back as the same threads.
6. **M6: More than one editor.** Colors, the filter, parallel rounds side by side (pick one or write your own), sequential rounds. Two-reviewer fixtures; e2e.
7. **M7: Checks.** Full suite, every e2e, the two-computer test extended (a review imported on A, accepted on B, origins kept), an independent review by a separate agent with fixes, `AGENTS.md` and `SLOG-FORMAT.md` sections, i18n template, the PC check steps for Ryan. The only milestone that touches the PC: bring `D:\neo` to `word-roundtrip` (asking once for permission to delete there, which git needs for its lock files), so Ryan's PC check is ready when he sits down. Then stop the scheduled task and wait for "merge".

## How a builder session works

1. Clone or update: work in `/home/claude/neo` if it's there, else `git clone https://github.com/mayhemrw/neo /home/claude/neo`. `git fetch origin`, `git checkout word-roundtrip`, `git pull --ff-only`. `npm install` if `node_modules` is missing.
2. Read `AGENTS.md` (project rules: nothing interrupts typing, words are never lost, the renderer never touches disk, every string through `t()`, every text change logged) and this whole file.
3. **The lock.** Look at "Claim" below. If a milestone is claimed and its heartbeat is under 45 minutes old, another session is working: send Ryan nothing, end at once. Otherwise claim the next unfinished milestone: write the claim (milestone, session start time in UTC, heartbeat = now), commit "Phase 6: claim M<n>", push. If the push is refused, pull and look again.
4. Work the milestone. Commit and push at least every 30 minutes, updating the heartbeat each time. Take defaults on anything undecided and note the question below.
5. Finish: the checks above, the progress log below (what's done, test counts, anything for Ryan), the claim cleared, pushed. If the claude.ai Project tool is available, mirror this file to `claude/Phase 6 Plan.md` and the log to `claude/Phase 6 Progress.md`. Send Ryan a short phone-friendly report (SendUserMessage) with 1 to 4 pictures (SendUserFile): what's done, what's next, any question for him.
6. If milestones remain and there's time, start the next one in the same session (claim it first). When M7 is done, disable the scheduled task (`update_trigger` with `enabled: false`; its id is under "Claim"; never delete it).

**No permission prompts for deleting.** Builder sessions M1 to M6 work only in the cloud copy: they never use Ryan's PC (no device tools, no `D:\neo`) and never ask for permission to delete anything, anywhere. Anything that needs it (bringing `D:\neo` up to the branch, where git removes its own lock files) waits for M7, the final milestone, which asks once.

Running the Electron tests in the cloud: `timeout 600 xvfb-run -a -s "-screen 0 1400x900x24" npx electron --no-sandbox scripts/<name>.e2e.js` (Electron needs `--no-sandbox` as root). The devices test is plain Node: `node scripts/devices.e2e.js`. Screenshots: `NEO_TEST_SHOTS=<folder>`. A .docx to pictures: `soffice --headless --convert-to pdf`, then `pdftoppm -png -r 60`. Commits end with the attribution lines the session's instructions give. Never commit Ryan's own writing or anything from his clients as a fixture.

## Claim

- Scheduled task: `trig_01G2ZxJvq3EbmHSLDeaCnd9t` ("NEO phase 6 builder", hourly at :36 Pacific, automatic approval, push notifications). A session may also start the next one at once with `fire_trigger` on this id once its milestone is pushed and the claim cleared.
- Claimed: none

## Open questions

- (M3) Decision 3: answered, 3b (formatting changes stay suggestions).
- (M3, default taken) A book's **Duplicate** leaves `review.json` and `reviews/` behind, like the log and versions: the copy starts with no review.
- (M3, default taken) A file from somewhere else, or whose version can't be read, asks which version it was sent from (the last six rounds and "The book as it is now", closest by text first).
- (M2, default taken) The file for an editor opens with **Track Changes already on** (`<w:trackRevisions/>` in its settings), so the editor can't forget. Say if you'd rather leave that to them.
- (M2, default taken) The version is named after the file is saved, so cancelling the save dialog names nothing. Rounds and the editors' names (the last 12, newest first, offered as buttons) live in `review.json`.
- (M1, small, default taken) Footnotes and text boxes in an editor's file aren't read as text; the import will count them and say so ("2 footnotes weren't read"). NEO has no footnotes, so this seems right; say if editors you work with put notes in footnotes rather than comments.

## Progress log

- Oct 9, 8:19 AM PT: Ryan accepted decision 2's default for now; beta testers will weigh in later (on the Roadmap).

- Oct 9, 8:16 AM PT: Ryan chose 1a and 3b. Decision 2 open (he's unsure authors want editors named); building the recommended default written under decision 2 (editor text always marked as an editor's, no names in the log, an opt-in "Name the editors" in the report).

- Oct 9, 8:05 AM PT (M3 done): File → Import Review… (and a single .docx dropped on the open book's page). Main reads the file (`review:pick`, `review:read`: `review-docx.js` in main, a token per file so the window never hands a path back to copy) and keeps a copy in `reviews/<round>-<reviewer>.docx` (`review:keep`, `libName`, a new name if taken). New `review-match.js` matches it to the version it was sent from (the round's version, read through `history:text`): chapters by bookmark, else by title, else by text (likeness ≥ 0.5, else "not placed"); tracked changes into suggestions (one per person's run, moves as one, formatting and chapter-title changes their own kinds, one person's deletion of another's insertion left out and counted); changes made without Track Changes (paragraphs matched, then words); comments into threads with replies and resolved; anchors as quotes with 32 characters each side, found again by `findAnchor` (out of date when the passage was rewritten). `review.json` gains `imports`, `reviewers` (with colors), `suggestions` (`status: 'open'`) and `threads`. A summary says what came in ("Dana Editor: 1 change, 1 comment", plus footnotes, text boxes, unplaced parts). Nothing in the book changes at import. Tests: `review-match.test.js` (18: chapters reordered, renamed, from a file not NEO's; every change kind; untracked; a part's title; comments; anchors after edits elsewhere, twice-used words, insertions, rewritten passages); `npm run test:review` now 11 (import, untracked, a file not from NEO with the which-version question). `npm test` 406 pass; lint 29. Not covered by a test: the drop itself (a test can't hand the page a real file's path).

- Oct 9, 7:58 AM PT (M2 done): File → Export → Word for an Editor… (`exportForEditor`, REVIEW section of `app.js`; `doExport('review')`). A small dialog asks who it's for (the last name filled in, earlier names as buttons; won't go on without a name; never over another dialog). Then everything is saved, NEO's regular Word file is built (decision 4b) with a hidden bookmark `_NEO_ch_<n>` at each section's first paragraph (`buildDocxEntries(data, { marks: true })`; every export section now knows its `chId`), and `ReviewDocx.forReview` adds a `w14:paraId` to every paragraph, the round id in `docProps/custom.xml` (`NEO.ReviewRound`, ids like `r20261009-1a2b3c`) and Track Changes on. After the save, the version "Sent to Dana (Oct 9)" is named (`auto: 'word'`, `history:mark` now takes it) and `review.json` gets `{ v, editors, rounds, reviewers, suggestions, threads }` with the round `{ id, at, to, file, version: { file, name, dev, n, h, copy }, chapters: [{ num, id, kind, title }], imports }`. New e2e `npm run test:review` (`scripts/review.e2e.js`, 7 tests: palette, dialog, cancel names nothing, the file's parts, a reviewer's edit read back to the right chapter with its paragraph id kept, NEO's import still reads it, a second round). 4 new unit tests for `forReview` (32 in `review-docx.test.js`). `npm test` 388 pass; lint 29; `test:manuscript` and `test:slog` still pass. The sample for the phone task is `scripts/fixtures/review/sample-for-review.docx` (A Tale of Two Cities, two chapters).

- Oct 9, 7:44 AM PT (M1 done): `review-docx.js`, Word's review markup read by its own XML tokenizer (namespaces resolved by URI, so any prefix reads): insertions, deletions, one editor's deletion inside another's insertion, moves paired by name (one move counts once, ranges across paragraphs), bold/italic changes with what they were (run, character style, paragraph style), paragraph formatting changes, paragraph marks inserted or deleted (split and joined paragraphs, `joined(model, 'after'|'before')`), whole paragraphs added or removed, comments with ranges in both texts, replies (`paraIdParent`), resolved (`done`), UTC dates (`commentsExtensible`), `people.xml`, NEO's round id from `docProps/custom.xml`, bookmarks, tables; drawings, text boxes, field codes and footnotes kept out of the text (counted in `notes`). `summary` counts by author for the import's sentence; `readDocx` unzips with `slog-zip.js`. Fixtures: hand-written OOXML in `scripts/review-docx.test.js` (28 tests) and `scripts/fixtures/review/lo-tracked.docx`, written by LibreOffice 24.2 from `lo-tracked.fodt` (two reviewers, a comment). The existing import still reads a tracked file as the editor left it (new test in `import.test.js`). `npm test` 384 pass; lint 29 (under the 31 baseline). AGENTS.md has a row for the file.

- Oct 9, 7:40 AM PT: Ryan chose 4b and 6b (with Resolve and Resolve and Delete). Others still on defaults while he reads the explanation of 1 to 3.

- Oct 9, 7:30 AM PT: plan written; branch cut from `main` at `2ad5154`.

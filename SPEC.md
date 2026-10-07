# Neo Fork Spec: Scribe's Log and Editor Features

Oct 6, 2026 · @Ryan

## Overview

This fork of [Neo](https://github.com/hughhowey/neo) adds a verifiable writing-process record (the Scribe's Log, "Slog" for short) plus the editor-workflow features a working author needs, without breaking Neo's minimalism.

Two problems drive it. Publishers increasingly want authors to show they wrote their books, and Neo has no process record beyond its SHA-256 PDF snapshot. And every editor and publisher works in Word, so Neo is a dead end once a manuscript leaves the author's hands.

Neo is MIT-licensed and small: an Electron shell (`main.js`), a preload bridge (`preload.js`), and a renderer (`app.js`, `styles.css`, `index.html`). Books live in `~/Documents/NEO Library`, one folder per book, chapters as HTML, metadata as JSON. All new features follow that same plain-files approach.

## Design principles

Every feature is invisible until called and gone when dismissed, the way Neo already handles spellcheck.

- **On-demand only.** No new toolbars, panels, or persistent buttons. New actions live in the command palette and keyboard shortcuts.
- **Writing view stays clean.** Review markup, logs, and stats appear only in their own modes.
- **Local-first.** Everything is stored as plain files in the book's folder. The only data that leaves the machine is hashes sent for timestamping.
- **Honest claims.** The Scribe's Log is documented as strong process evidence, not proof of authorship. No UI or export says "proves you wrote this."
- **Sync-friendly.** Files that are done changing never change again, so cloud sync and version history don't churn.
- **Fork-first.** Build everything assuming it stays in this fork. Small, self-contained features can be offered upstream as pull requests.

## Build order

The Scribe's Log comes first because snapshots and multi-editor tracking both depend on it. Each phase should be working and tested before the next starts.

**Step zero, feature audit:** before writing any code, review Neo's current source, README, TUTORIAL, and open pull requests, and list anything in this spec that already exists or is in progress. Drop or adapt those items instead of rebuilding them. Known so far: focus/typewriter mode already exists.

1. **Scribe's Log core:** edit log, chunked storage, hash chain, move detection, per-book toggle.
2. **Timestamping and verification:** external timestamps, author signing key, clock tamper check, verification report, standalone verifier.
3. **Snapshots:** session and named versions rebuilt from the log, compare and restore.
4. **Quick wins:** whole-book find and replace, command palette.
5. **Editing aids:** standard manuscript format export.
6. **Word round-trip:** tracked changes, comments, multiple editors, review mode.

## Development workflow

Keep `main` clean so Hugh's updates merge in without colliding with half-built features.

- **Remotes:** `origin` is this fork (`mayhemrw/neo`); `upstream` is Hugh's repo (`hughhowey/neo`).
- **Never build on `main`.** It holds only Hugh's code plus finished, tested phases. Pull Hugh's changes there with `git fetch upstream` then `git merge upstream/main`.
- **One branch per feature,** cut from `main` and named for its build-order phase (e.g. `scribes-log`, `snapshots`). Merge into `main` only when the phase is working and tested.
- **Staying current:** after updating `main` from upstream, merge `main` into any active feature branch.
- **Upstream pull requests** come from a fresh branch off `upstream/main` (not this fork's `main`, which carries fork-only files like this spec) containing only that one feature.

## Scribe's Log

The Scribe's Log records every change to a manuscript in a tamper-evident log and anchors it to outside timestamps, producing a process record a publisher can verify without Neo.

### Edit log

- Record insertions, deletions, and pastes with timestamps, grouped into bursts of about 1 to 2 seconds rather than one entry per keystroke.
- Each entry stores chapter, position, the change, and timing within the burst.
- Store changes only, never repeated full-text copies.
- Expected size: roughly 5 to 20 MB compressed for a 90,000-word novel.

### Storage

- One log per book, in the book's folder, split into one chunk file per writing session.
- A closed chunk is never modified again, so it syncs once and doesn't churn Google Drive version history.
- Only the current session's chunk is actively written.
- On demand (or when a book is marked finished), merge all chunks into one compressed archive.
- A corrupted chunk loses one session's record, not the whole book's.

### Hash chain

- Every entry includes the hash of the previous entry, so editing or deleting an old entry breaks every hash after it.
- Each chunk opens with the final hash of the previous chunk.

### External timestamps

- Periodically (about hourly while writing, plus at session end) send the current chain hash to an outside service.
- Support RFC 3161 timestamp authorities (e.g. FreeTSA) and OpenTimestamps.
- Only the hash leaves the machine, never manuscript text.
- Store the returned receipts alongside the chunks. Size is negligible: a few KB per RFC 3161 token, a few hundred bytes per OpenTimestamps proof.
- Queue requests when offline and send them when back online.

### Move detection

- When pasted text matches text already in the log (another chapter, Darlings, an earlier Neo book), log it as a move with a reference to its origin, not as a paste.
- Pastes from outside Neo are logged as outside pastes with timestamp and size, nothing more.&#32;
- Imported drafts (.docx, .txt, .md) are logged as imports with the source file's date and hash.

### Author signing

- Generate a personal signing key pair on first use. The private key never leaves the author's computer, is password-protected, and gets backed up by the author; only the public key is ever shared.
- Sign each closed chunk and the final archive.
- The public key ships with every verification package, and its fingerprint is timestamped at the start of each book's log. Publishing it on the author's website is optional.

### Clock tamper check

- Flag in the log when the system clock jumps backward, or forward by more than a set threshold.
- Cross-check local time against timestamp receipts. All log times are stored in UTC, so daylight saving changes and time zone travel never trigger a flag; local time is used for display only.

### Process artifacts

- Include Outline changes, Darlings moves, and Placeholder creation and resolution in the record.

### AI-use disclosure

- Optional per-book note field where the author records any AI use (e.g. title brainstorming). Included in the verification report.

### Per-book toggle

- The Scribe's Log can be turned on or off per book, defaulting to on for new books.
- Needed for ghostwriting, where a process log showing the ghostwriter typed the book could conflict with an NDA.

### Verification report and verifier

- **Report:** timeline, session count and calendar, words typed vs. moved vs. pasted from outside, revision density, flagged clock events, AI disclosure.
- **Share without the text:** an export containing stats, timeline, hashes, receipts, and signatures but no manuscript text. Full replay is a separate export, sent only if a publisher asks.
- **Replay:** a playback of the manuscript being written, with speed control.
- **Standalone verifier:** a free static web page, running entirely in the browser, that checks the chain, signatures, and receipts without installing Neo.

## Snapshots

Snapshots aren't stored copies: Neo rebuilds any chapter as it stood at any moment by replaying the Scribe's Log up to that time.

- **Session versions:** an automatic version per chapter at the end of every writing session, listed by date.
- **Named snapshots:** manual milestones such as "sent to editor" or "before the big rewrite." Exporting to Word creates one automatically (see Word round-trip).
- **Compare:** show what changed between a snapshot and the current text.
- **Restore:** restore a whole chapter, or copy a single passage back.
- **Checkpoints:** periodically save a small compressed checkpoint so rebuilding late in a book doesn't require replaying the whole log.
- **Fallback when the Scribe's Log is off:** save a compressed copy of each changed chapter at session end instead. Still small, since a chapter is a few KB of text.

## Quick wins

Two small features with high daily value and no clutter.

### Whole-book find and replace

- Search across every chapter, with a results list showing each hit in context, grouped by chapter.
- Options: match case, whole word.
- Replace one at a time or all at once. A replace-all creates a named snapshot first so it can be undone.
- Replacements are logged in the Scribe's Log as edits.

### Command palette

- One shortcut (⌘K / Ctrl+K) opens a search box listing every action, with its shortcut shown beside it.
- Every new feature in this spec registers here instead of getting a button.

## Editing aids

Run from the palette when a manuscript is ready to submit.

### Standard manuscript format export

- Export to .docx and PDF in submission format: Times New Roman 12 pt (Courier optional), double-spaced, 1-inch margins, first-line indents.
- Contact block on page one, header with surname / title / page number, chapters starting on new pages, `#` for scene breaks.
- Word count rounded to the nearest thousand on the title page.
- Already on Hugh's roadmap, so a strong candidate for a pull request upstream.

## Word round-trip

Authors export a .docx to one or more editors, then import their tracked changes and comments back into Neo as reviewable suggestions.

### Export

- Export the book (or selected chapters) to .docx with chapter and scene breaks intact.
- Each export creates a named snapshot (e.g. "Sent to \[editor\], \[date\]") recording exactly what that person received.
- Embed a hidden export ID in the .docx so imports match the right snapshot automatically.

### Import

- Import a reviewed .docx and compare it against the snapshot it came from.
- Tracked insertions and deletions become accept/reject suggestions.
- Untracked changes (an editor who forgot Track Changes) are detected by diffing against the snapshot and shown as suggestions too.
- Formatting-only changes are applied silently rather than shown as suggestions.

### Comments

- Word comments import as margin notes anchored to their text, with reply threads preserved.
- The author can reply to or resolve any comment.
- Replies export back to Word as real comment replies on the next export.

### Multiple editors

- Each reviewer is identified by the author name Word stamps on their changes and comments, and gets a consistent color.
- Filter to show one reviewer, several, or all.
- **Parallel rounds:** several reviewers working from the same snapshot import independently. Where two reviewers changed the same passage, Neo shows both versions side by side; the author picks one or writes their own.
- **Sequential rounds:** a file passed from one editor to the next stacks naturally, with each reviewer's changes kept under their own name.

### Review mode

- A separate on-demand view. The normal writing page never shows markup or margin notes.
- Contains the suggestion list, comments margin, reviewer filter, and accept/reject controls (single, by reviewer, or all).
- Accepted and rejected suggestions are logged in the Scribe's Log, attributed to the reviewer, so the process record distinguishes author and editor work.

## Out of scope and decisions

**Out of scope:** inline comments outside review mode, a story bible or character database, formatting toolbars, accounts or cloud services, and self-reported paste tagging.

**Decisions:**

- **Timestamp services:** support both. FreeTSA (RFC 3161) is primary because receipts come back instantly. OpenTimestamps is the backup because it's anchored to Bitcoin and doesn't depend on any organization surviving; its receipts confirm within a few hours.
- **Public key:** included in every verification package, and its fingerprint is written into the first timestamped entry of each book's log, proving the key existed when the book began. Posting it on the author's website is optional extra credibility, not required.
- **Clock-jump threshold:** flag any backward jump over 2 minutes. Forward jumps are normal after sleep, so flag only forward jumps over 2 minutes that don't line up with a system sleep/wake event. Also flag when local time and a timestamp receipt disagree by more than 5 minutes.
- **Per-book default:** on.
- **Verifier:** a static web page that runs entirely in the browser. No desktop tool.
- **Pre-existing books:** the first time any book is opened with the Scribe's Log available, its current text is logged as a dated baseline, labeled as pre-existing with no process record. Everything after that is logged normally.

**Still open:**

- [ ] Which features to offer Hugh upstream as pull requests.

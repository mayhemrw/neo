# Neo Fork Spec: Scribe's Log and Editor Features

Oct 7, 2026 · @Ryan

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
- **Integrity first, identity optional.** The record of how the book was built is the point. Proving who the writer is comes second, and every book verifies without it.
- **Nothing for the writer to keep.** Integrity works with no keys, passwords, or recovery steps. Anything a writer could lose must be optional and fail gracefully.
- **Sync-friendly.** Files that are done changing never change again, so cloud sync and version history don't churn.
- **Fork-first.** Build everything assuming it stays in this fork. Small, self-contained features can be offered upstream as pull requests.

## Build order

The Scribe's Log comes first because snapshots and multi-editor tracking both depend on it. Each phase should be working and tested before the next starts.

**Step zero, feature audit:** done Oct 6 against Neo 1.4.2 (see the Feature Audit doc). Results are folded into each section below: find and replace mostly exists, Word export exists, focus/typewriter mode exists, and open PR #252 overlaps snapshots (we're building our own design instead).

1. **Scribe's Log core:** edit log, chunked storage, hash chain, move detection, per-book toggle.
2. **Timestamping and verification:** external timestamps, clock tamper check, verification report, standalone verifier.
3. **Snapshots:** session and named versions rebuilt from the log, compare and restore.
4. **Quick wins:** additions to Neo's existing find and replace, command palette.
5. **Editing aids:** standard manuscript format export.
6. **Word round-trip:** tracked changes, comments, multiple editors, review mode.
7. **Identity (optional):** per-pen-name signing keys. Can be built any time after phase 2; the log format reserves room for it from phase 1.

## Development workflow

Keep `main` clean so Hugh's updates merge in without colliding with half-built features.

- **Remotes:** `origin` is this fork (`mayhemrw/neo-scribe`); `upstream` is Hugh's repo (`hughhowey/neo`).
- **Never build on `main`.** It holds only Hugh's code plus finished, tested phases. Pull Hugh's changes there with `git fetch upstream` then `git merge upstream/main`.
- **One branch per feature,** cut from `main` and named for its build-order phase (e.g. `scribes-log`, `snapshots`). Merge into `main` only when the phase is working and tested.
- **Staying current:** after updating `main` from upstream, merge `main` into any active feature branch.
- **Upstream pull requests** come from a fresh branch off `upstream/main` (not this fork's `main`, which carries fork-only files like this spec) containing only that one feature.

## Scribe's Log

The Scribe's Log records every change to a manuscript in a tamper-evident log and anchors it to outside timestamps, producing a process record a publisher can verify without Neo.

### What it can and can't prove

The docs, the report, and the export screen all say this plainly.

**Can show:** the log hasn't been altered since each timestamp; the writing happened over the dates shown and wasn't reconstructed later; which text was typed in Neo, moved within the book, pasted from outside, or imported; and that the log ends in exactly the manuscript a publisher holds.

**Can't show:** that a human pressed the keys (Neo is open source, so a modified copy or OS-level automation could produce a fake log, though the timestamps force a faker to work in real time across the whole claimed period); that the ideas weren't AI's (hand-retyped AI text makes a real log); or anything about writing done outside Neo.

### Edit log

- Record insertions, deletions, and pastes with timestamps, grouped into bursts of about 1 to 2 seconds rather than one entry per keystroke.
- **Two-part entries.** Each entry keeps its metadata in the clear (type, chapter, position, size, timing) and commits to its text with a salted hash. The salt stops anyone guessing short phrases from their hashes, and the clear metadata lets a verifier recompute the stats without seeing a word.
- Store changes only, never repeated full-text copies.
- Reserve a signature field in the format from day one, so adding identity later doesn't mean converting old logs.
- Expected size: roughly 5 to 20 MB compressed for a 90,000-word novel.

### Storage

- One log per book, in the book's folder, split into one chunk file per writing session per device.
- A closed chunk is never modified again, so it syncs once and doesn't churn Google Drive version history.
- Only the current session's chunk is actively written. Neo's `writeFileDurable` has no append mode, so log chunks need their own crash-safe append.
- On demand (or when a book is marked finished), merge all chunks into one compressed archive.
- A corrupted chunk loses one session's record, not the whole book's.
- The log is included in Neo's daily backup zips. Whatever breaks a book could break its log too, so the backup carries both.

### Hash chain

- Every entry includes the hash of the previous entry, so editing or deleting an old entry breaks every hash after it.
- Each chunk opens with the final hash of the previous chunk.
- **One chain per device.** Each computer keeps its own chain, labeled with a device ID, so two devices writing before a sync never fork a chain.
- Changes that arrive from another device (Neo already adopts these through `refreshFromDisk`) are logged as "arrived from another device," not as typing.

### Final manuscript hash

- The log's last state records a hash of the finished text, normalized the same way every time (plain text, standard Unicode form, collapsed whitespace).
- A publisher who holds the manuscript can hash it and confirm the log ends in exactly that book, without receiving the log's text.

### External timestamps

- Every 15 minutes while writing, plus at session end, send the current chain hash to outside services. The gap between stamps is the only window where a log could be quietly rewritten.
- RFC 3161 timestamps from a major certificate authority are primary, OpenTimestamps is the independent backup, and FreeTSA is a fallback.
- Only the hash leaves the machine, never manuscript text or names.
- Store the returned receipts alongside the chunks, with each service's certificate chain so the timestamps stay checkable after certificates expire. Size is negligible: a few KB per RFC 3161 token, a few hundred bytes per OpenTimestamps proof.
- Queue requests when offline and send them when back online.

### Move detection and text origin

- When pasted text matches text already in the log (another chapter, Darlings, an earlier Neo book), log it as a move with a reference to its origin, not as a paste.
- Pastes from outside Neo are logged as outside pastes with timestamp and size, nothing more.
- Imported drafts (.docx, .txt, .md) are logged as imports with the source file's date and hash.
- **Text keeps its origin through edits.** An outside paste that's later revised is reported as "pasted from outside, then revised," never as typed. The report works out origin character by character by replaying the log. No laundering.

### Clock tamper check

- Flag in the log when the system clock jumps backward, or forward by more than a set threshold.
- Cross-check local time against timestamp receipts. All log times are stored in UTC, so daylight saving changes and time zone travel never trigger a flag; local time is used for display only.

### Process artifacts

- Include Outline changes, Darlings moves, and Placeholder creation and resolution in the record.
- Author name (pen name) changes are logged as an event. The names themselves are salted-hashed like text, so the no-text export shows that the name changed but not what it was.

### AI-use disclosure

- Optional per-book note field where the author records any AI use (e.g. title brainstorming). Included in the verification report.

### Per-book toggle

- The Scribe's Log can be turned on or off per book, defaulting to on for new books.
- Needed for ghostwriting, where a process log showing the ghostwriter typed the book could conflict with an NDA.

### Platforms

- Desktop only for now. Neo Pocket (the phone app) shares the editor code, so the log must be cleanly switched off there, not half-running.
- Edits made on a phone reach the desktop through sync and are logged as "arrived from another device."

### Verification report and verifier

- **Report:** timeline, session count and calendar, text origin (typed, moved, pasted from outside, imported, revised after pasting), revision density, flagged clock events, AI disclosure. No single headline percentage; the breakdown and timeline speak for themselves.
- **Author name:** the report uses the book's own author name (`book.author`) and nothing else. Neo's library-level real name and saved email never appear unless the writer adds them.
- **Privacy options:** the shared report can show exact session times, dates only, or weeks only, since a session calendar reveals when someone writes.
- **Share without the text:** an export containing metadata for every entry, salted text hashes, the final manuscript hash, timestamps, and receipts, but no manuscript text. A verifier can check the chain and recompute every stat from it.
- **Full replay:** a separate export that adds the text and salts, sent only if someone asks. The export screen says plainly that it includes every deleted passage and every past author name.
- **Replay:** a playback of the manuscript being written, with speed control.
- **Standalone verifier:** a single static HTML page that runs entirely in the browser and checks the chain, stats, and receipts without installing Neo. A copy goes inside every export, so verification never depends on a website still existing. Checking an OpenTimestamps receipt needs Bitcoin block data from a public source; offline, the verifier relies on the certificate-authority timestamp.
- **Open format:** publish the log format (fields, hashing, normalization, signature scheme) as an open spec so anyone can write a verifier.

### Identity (optional, phase 7)

Identity links a book to a pen name and a pen name's books to each other. It's useful for a track record and for disputes, but integrity never depends on it.

- **One key per pen name,** not per person, so reports from different pen names can't be linked by their key. Neo creates a pen name's key the first time that name signs something.
- **Sign at export only,** with whatever pen name the book carries then. A book moved to a new pen name carries only that name's signature.
- **Storage:** the key is stored encrypted in the library folder, so it syncs and is backed up with everything else. The unlock code goes to the writer's own inbox through Neo's existing email feature, with a searchable subject line. Each computer unlocks the key once and keeps it in the OS keychain (`safeStorage`).
- **Lost key:** Neo makes a new one. Earlier books still verify under the old key; the writer can post both fingerprints to link them.
- **Stolen key:** make a new key and post "old key retired as of [date]." Signatures made before that date keep their timestamps.
- **Proving a key is yours:** optionally post its fingerprint somewhere you control, like a website. The report shows each key's "first seen" date either way.

## Snapshots

Snapshots aren't stored copies: Neo rebuilds any chapter as it stood at any moment by replaying the Scribe's Log up to that time. This is deliberately a different design from open upstream PR #252, which stores full copies every 5 minutes and caps them at 50 per chapter (a cap that would eventually delete "sent to editor" snapshots).

- **Session versions:** an automatic version per chapter at the end of every writing session, listed by date.
- **Named snapshots:** manual milestones such as "sent to editor" or "before the big rewrite." Exporting to Word creates one automatically (see Word round-trip). Don't use ⌘⇧S as the shortcut: Neo uses it for strikethrough.
- **Compare:** show what changed between a snapshot and the current text.
- **Restore:** restore a whole chapter, or copy a single passage back.
- **Checkpoints:** periodically save a small compressed checkpoint so rebuilding late in a book doesn't require replaying the whole log.
- **Fallback when the Scribe's Log is off:** save a compressed copy of each changed chapter at session end instead. Still small, since a chapter is a few KB of text.

## Quick wins

Two small features with high daily value and no clutter.

### Whole-book find and replace

Neo already has this (⌘F): it searches the whole manuscript, replaces one or all, and ⌘Z undoes a Replace All. Add only what's missing:

- A results list showing each hit in context, grouped by chapter.
- Options: match case (search is currently always case-insensitive), whole word.
- A named snapshot before every Replace All. Neo's current undo lives in memory and is gone after a restart.
- Replacements are logged in the Scribe's Log as edits.

### Command palette

- One shortcut (⌘K / Ctrl+K, currently unused) opens a search box listing every action, with its shortcut shown beside it.
- Every new feature in this spec registers here instead of getting a button.

## Editing aids

Run from the palette when a manuscript is ready to submit.

### Standard manuscript format export

- Export to .docx and PDF in submission format: Times New Roman 12 pt (Courier optional), double-spaced, 1-inch margins, first-line indents.
- Contact block on page one, header with surname / title / page number, chapters starting on new pages, `#` for scene breaks.
- Word count rounded to the nearest thousand on the title page.
- Neo's current Word export is 1.5-spaced with no header or page numbers, so this is a new export, not a tweak.
- Already on Hugh's roadmap, so a strong candidate for a pull request upstream.

## Word round-trip

Authors export a .docx to one or more editors, then import their tracked changes and comments back into Neo as reviewable suggestions.

### Export

- Build on Neo's existing Word export, which already keeps chapter and scene breaks intact.
- Each export creates a named snapshot (e.g. "Sent to \[editor\], \[date\]") recording exactly what that person received.
- Embed a hidden export ID in the .docx so imports match the right snapshot automatically.

### Import

- Import a reviewed .docx into the existing book and compare it against the snapshot it came from. Neo's current import always makes a new book, silently accepts every tracked change, and drops comments, so this is a new path.
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

**Out of scope:** inline comments outside review mode, a story bible or character database, formatting toolbars, accounts or cloud services, self-reported paste tagging, and logging on phones (for now).

**Decisions:**

- **Timestamp services:** a major certificate authority's RFC 3161 service is primary, because its timestamps carry the most weight with a publisher's lawyer. OpenTimestamps is the backup because it's anchored to Bitcoin and doesn't depend on any organization surviving; its receipts confirm within a few hours. FreeTSA is a fallback.
- **Timestamp interval:** every 15 minutes while writing, plus session end.
- **Integrity vs. identity:** integrity is required and automatic; identity is optional and built last.
- **Keys:** one per pen name, signing at export only, stored encrypted in the library with an emailed unlock code. No device keys.
- **Chains:** one per device, labeled with a device ID.
- **Platforms:** desktop only.
- **Backups:** the log is included in daily backup zips.
- **Painted covers:** not logged. Covers aren't prose; writers can mention them in the AI disclosure note.
- **Author name in reports:** the book's own author name only, never the library's real name or email.
- **Snapshots:** our own log-based design, not PR #252.
- **Clock-jump threshold:** flag any backward jump over 2 minutes. Forward jumps are normal after sleep, so flag only forward jumps over 2 minutes that don't line up with a system sleep/wake event. Also flag when local time and a timestamp receipt disagree by more than 5 minutes.
- **Per-book default:** on.
- **Verifier:** a static web page that runs entirely in the browser, with a copy inside every export. No desktop tool.
- **Pre-existing books:** the first time any book is opened with the Scribe's Log available, its current text is logged as a dated baseline, labeled as pre-existing with no process record. Everything after that is logged normally.

**Parked for later:**

- Signing with an email account through Sigstore (a free public signing service). Nothing to lose, but the email becomes permanently public in a log that can't be deleted, which is risky for pen names. Possible later as an opt-in "Verify with email" at export.

**Still open:**

- [ ] Confirm the certificate authority's terms for using its timestamp service this way (DigiCert runs a public one at `timestamp.digicert.com`).
- [ ] Which features to offer Hugh upstream as pull requests. Manuscript format is the strongest candidate.

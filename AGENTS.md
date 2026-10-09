# NEO — notes for agents

NEO is a local word processor for books. It is an Electron app made of plain JavaScript, HTML, and CSS. There is no bundler, no framework, and no compile step. `npm start` runs `electron .`.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before adding a feature. The product is opinionated on purpose. A change that helps someone finish a book belongs here. A change that adds a panel, a prompt, or a dependency usually does not.

## Rules that override convenience

- Nothing interrupts a writer mid-sentence. No popups, no squiggles, no notifications while typing. Spellcheck is off until the writer asks for a pass.
- Controls stay hidden until hover or keyboard focus.
- Words are never discarded. Deleting text, unbinding a shelf, or losing a trash operation must leave the words recoverable (Darlings, a sibling chapter, or the system trash). `book:delete` uses `shell.trashItem`. If trash fails, leave the folder and show it.
- Books are plain files. No database, no proprietary format.
- The renderer never touches the filesystem. Disk access goes through `window.neo` (`preload.js`) to handlers in `main.js`.
- Do not save UI decoration into chapter HTML. Search highlights, spellcheck underlines, and focus dimming use the CSS Highlight API so they stay out of the file.
- Do not rewrite a chapter that has not changed. Libraries are synced with iCloud and Syncthing. A timer that writes every chapter on an interval will fight the other device.

## Where the code is

| File | Role |
|---|---|
| `main.js` | Window, menus, every filesystem operation, import parsing, PDF, backups |
| `preload.js` | The entire renderer API, `window.neo` |
| `index.html` | Two views: `#bookshelf-view` and `#editor-view`. CSP is `script-src 'self'` |
| `app.js` | The whole UI, in banner-marked sections. Search for the banner before reading the file |
| `styles.css` | All styling. Tokens are CSS variables at the top |
| `covers.js` | Shelf covers in the window: seeded canvas art plus real title type. `window.NeoCovers` |
| `art.js` | Painted covers in the main process. OpenAI only. Title and author are never sent to the image model |
| `i18n.js` | `t()` / `tk()`, shared by main and the window. English source text is the key |
| `spell-worker.js` | Hunspell WASM, forked with `utilityProcess`. Messages: `load`, `check`, `suggest`, `add` |
| `spell-ro.js` | Romanian diacritics, used by the worker. Does not alter the manuscript |
| `slog.js` | The Scribe's Log: the chain, chunk files, the diff (from `slog-diff.js`), finding moved text (a restore's too), and the `Recorder` the main process keeps each book's log with. Re-exports the checker's functions. Format: `SLOG-FORMAT.md` |
| `slog-verify.js` | The Scribe's Log's checker, in plain JavaScript that also runs in a browser: reading a log's files, chain check, replay, origins traced across devices, the manuscript text, receipts checked against the chains, coverage and the clock check (`checkLog`). Shared by NEO, `slog-check` and the verifier page; NEO puts Node's crypto into it (`useHash`) |
| `slog-stamp.js` | The main process's stamper: when to stamp, receipt files, the offline queue, fetching finished OpenTimestamps proofs |
| `slog-report.js` | The verification report: `reportStats` (origins overall and by chapter, pastes then revised, revision, sessions, the timeline, timestamps, flags, from `checkLog`'s result) and `renderReport` (one self-contained page, times exact, as dates or as weeks). Plain JavaScript that also runs in a browser, so NEO and the verifier make the same report |
| `slog-files.js` | A book's `scribes-log/` folder on disk, loose files and archives read as one (`listLog`, `loadLog`); Merge Log into Archive (`mergeIntoArchive`); the exports for verification (`buildExport`, `readExport`). Node only |
| `slog-history.js` | Versions rebuilt from the log (phase 3): `History.index` lists every chapter's session versions across every computer's chain (one per session that changed it; text that only arrived is the other computer's session), `rebuild`/`text` give the documents after any entry of a chain, `list` adds the copies of log-off sessions and the named versions, `versionText` gives one chapter of any of them. Checkpoints and the index cache live in `userData/slog/history`, never in the library, and are rebuilt whenever they don't match the log. Also the book's `versions/` folder (below) and `SessionCopies`. Node only |
| `slog-history-worker.js` | `slog-history.js` in its own process for the History window (forked with `utilityProcess`, like `spell-worker.js`; `main.js` runs the same `reply` itself if it can't start). Messages: `list`, `text`, `titles`, `restore`, `playback` |
| `slog-diff.js` | Diffs: the log's `diff`/`tokenHunks` (Myers over tags, words and spaces, capped), and the History window's `compare` (a chapter's paragraphs matched, then words within the changed ones, unchanged stretches folded) with `toHtml`/`viewHtml`, markup built fresh from the text. Plain JavaScript that also runs in a browser (`window.SlogDiff`, loaded by `index.html`) |
| `slog-playback.js` | Playback (phase 3): `build(chains, doc)` gives one chapter's steps (every entry that changed it on the device that made the change, every chain merged by time, arrivals skipped), `frame(pos)` the chapter after any step as clean markup (`SlogDiff.viewHtml` with a marker: what came in, what went, origins by the checker's Tracer in its light `detail: 'moved'` mode), `delays`/`times`/`positionAt` for timing with pauses skipped, and `mount`, the player itself (DOM only, strings through a `t` passed in). Plain JavaScript that also runs in a browser (`globalThis.SlogPlayback`); the verifier inlines it |
| `slog-zip.js` | Zip files for archives and exports: reading (inflate handed in, or the browser's `DecompressionStream`), writing, CRC-32. Plain JavaScript that also runs in a browser |
| `verifier/` | The standalone verifier page that every export carries: `page.html` and `page.js` (the page), `check.js` (sorting what's dropped, checking it, saying what checked in plain words), `manuscript.js` (reading a .txt or .docx and matching it to the log's fingerprint), `build.js` (one self-contained page with the checker's files inside; main.js builds it for each export). Watch a chapter being written (`slog-playback.js`) for a log with its words. Plain JavaScript that also runs in Node, except `page.js` |
| `review-docx.js` | The Word round-trip (phase 6): reading an editor's .docx, tracked changes (insertions, deletions, moves, formatting, paragraph marks), comments with replies and resolved threads, people, NEO's round id, through its own XML tokenizer (`parse`, `joined`, `summary`, `readDocx`). Plain JavaScript that also runs in a browser (`globalThis.ReviewDocx`). Nothing here touches a chapter |
| `review-match.js` | The Word round-trip (phase 6): an editor's file matched to the book it was sent from: chapters by bookmark (`_NEO_ch_<n>`), title or text; tracked changes into suggestions (one per person's run of changes, moves, formatting, titles); changes made without Track Changes (the file's text before its changes against the version sent, `textHunks`); comments into threads; anchors as quotes (`anchorIn`, `findAnchor`) over a chapter's text with its paragraphs joined by U+2029. Plain JavaScript that also runs in a browser (`globalThis.ReviewMatch`) |
| `manuscript.js` | Standard manuscript format (phase 5): the word count's rounding, the header's surname, the `.docx`'s parts and the PDF's page, from a model the window hands it. Plain JavaScript that also runs in Node (`window.NeoManuscript`, loaded by `index.html`) |
| `slog-hash.js`, `stamp-ots.js`, `stamp-tsa.js` | Outside timestamps for the Scribe's Log, in plain JavaScript that also runs in a browser: SHA-256/HMAC/SHA-1/RIPEMD-160, OpenTimestamps proofs and calendars, RFC 3161 tokens (checked through WebCrypto). The network is a `fetch` passed in. Trusted roots are in `certs/` |
| `locales/<code>.json` | One language. Regional files (`fr-CA.json`) hold only the strings that differ |
| `pocket/` | Capacitor shell. It does not contain its own editor |
| `print/` | Vendored Paged.js and hyphenation patterns for paperback PDFs |

`app.js` section banners look like `/*  SAVING  */`. Start there: bookshelf, bound shelves, editor open, typing, poetry, screenplays, placeholders, nav, tabs, outline, outline cards, darlings, counters, saving, refresh, structural undo, find, command palette, import, spellcheck, focus, goals, export, manuscript format.

Menus are built in `buildMenu()` in `main.js`. A menu click sends `{ type, ... }` to the window; `app.js` handles it on `window.neo.onMenu`.

## Command palette

⌘K / Ctrl+K (View → Command Palette…; COMMAND PALETTE in `app.js`) lists every command in NEO's menus by name, as the menu has it right now. `paletteItems` in `main.js` walks `Menu.getApplicationMenu()` into `{ key, label, path, shortcut, enabled, checked }` (`key` is where it sits, menu indexes like `"2.5.0"`; `shortcut` the accelerator as the platform shows it, `accelText`, or the text after a label's tab; a greyed submenu's commands, hidden items, separators, items whose id starts `info-` and the palette itself are left out). Choosing one (`palette:run`) clicks that very menu item in main, found by its key and checked by its name (by name and place together if the menu was rebuilt, never by name alone), so the palette can't disagree with the menus; edit roles run as the menu runs them. The window closes the palette and gives the page its caret back first, so Copy, Paste and Undo act on the page.

- **From here on, every new feature gets a menu item instead of a button**, and so a palette entry. Commands the window catches itself (tabs, chapters) are in View → Go To, their accelerators shown but not registered (`registerAccelerator: false`).
- Searching (`paletteFilter`, `paletteScore`): every typed word must start a word of the name (best), start a word of its place, or be found anywhere; accents and case don't matter, and the whole name typed comes first ("manuscript" is the tab, not Manuscript Format…). Nothing typed: the last five used first (`neo-palette-recent` in `localStorage`, per device), then the menu in order, leaving out the commands the writer hid. Greyed commands are listed greyed and say they can't be used now.
- Choosing what's listed: the pencil beside the box (shown on hover, or Tab to it) lists every command under its place (`paletteGroups`) with a tick each, and a heading per place that ticks or unticks them all (Spellcheck Language at once). Hidden commands (`neo-palette-hidden`, per device, by `paletteId`) stay out of the list as it opens, recent ones included, but typing still finds them. Enter ticks the line it's on there; Esc leaves choosing, not the palette. Drag-to-reorder is on the roadmap (the project's Roadmap doc).
- It owns the keyboard while it's up: ↑ ↓, Page Up/Down, Enter, Esc (closes and puts the caret back), and ⌘K again closes it. It never opens over another dialog. Desktop only: Pocket's bridge has no `palette`.
- `scripts/palette.test.js` (matching, ordering, recent, hidden, groups, `accelText`, the menu walk on a stand-in menu); `npm run test:palette` (`scripts/palette.e2e.js`, Electron) drives it on NEO's real menu.

## Outline cards

The Outline tab shows the book as index cards (OUTLINE CARDS in `app.js`) unless `library.outlineView` is `'list'`. A script's Outline is always cards, one per scene (`scriptScenes`): heading, length in eighths, cast, and a note in `book.sceneNotes`, keyed by `data-scene-id` on the heading line. Dragging a scene card calls `spMoveScene`.

- Cards come from the manuscript, not a separate structure: each chapter is cut at its `p.scene-break` lines (`chapterSegments`). A section that holds a `p[data-sec-id]` belongs to that note in `book.sectionNotes`; the first section to carry an id owns it, because paragraphs split from a written ghost inherit the id. Others show their first line.
- Moving a card moves its paragraphs and *** between chapter bodies, then `syncChapter` and `orderSectionNotes`. Every move takes a `snapshotStructure` first.
- `syncGhosts` leaves a ghost where it stands and places a note the page lacks before the next section that's there. It never reorders ghosts.
- Loose cards are `book.looseCards`, shown in the right-hand pane while the Outline is up. A section card dragged there (or Move to loose cards) goes both ways: a section with writing takes its words along as `card.html`, out of the manuscript and the counts until it's placed again. Chapter cards and a script's scene cards go there too: the card carries the chapter (words, title, notes, kind; `held: 'chapter'`) or the scene's lines (`held: 'scene'`), written to book.json before they leave the page, and comes back whole (a chapter only between chapters). A card's Delete sends held words to Darlings first. A section card's Delete section sends its writing to Darlings (`deleteSectionToDarlings`).
- Several cards at once: ⌘-click (Ctrl-click) toggles a card, Shift-click takes a run, and a drag across empty outline space sweeps (`cardLasso`). The picked cards are `cardSel` (keys from `cardKey`), kept across a redraw and dropped after a move. Delete/Backspace or the right-click menu runs `deleteSelectedCards`: one `snapshotStructure`, the single deletes run quiet, sections and scenes from the last up, and a book keeps at least one chapter.
- `joinChapter` makes a chapter a section of another (List Tab on a chapter line, or a chapter card dropped on the middle of another). It moves the lines, persists the receiving chapter, and only then deletes the emptied one.
- In the List, Enter always makes a chapter and Tab always makes a section.
- On a card made new (`cardEditor.fresh`), Enter with words on it opens the next new card; Enter on an empty one, or Esc, stops. A pasted list (`outlineLines`, `pasteOutline`) becomes one card per line: on a chapter card, top lines are chapters and indented ones their sections.
- A script scene's card note shows in gray on the scene's empty first line (`spSceneNoteGhosts`, a `data-scene-note` screen mark that `captureBody` strips).

Brighter Interface is two settings: `library.uiBright` while writing (and on the shelf), `library.uiBrightAside` on the other tabs, bright unless turned off. `applyBright` picks one on every tab switch.
- The walking note (`walkNoteUpdate`) is an overlay inside `.chapter`, plus a `data-walk` mark on the caret's paragraph that `captureBody` strips. `note.dismissed` hides it for good.

## Screenplays

A book whose `book.json` says `"format": "screenplay"` is a script. Right-click (long-press) a shelf's + for New Script. The SCREENPLAYS section of `app.js` holds the feature; `scripts/screenplay.test.js` tests its rules.

- The whole script is one chapter, so selection and the arrow keys run through every scene. Scenes are found by their headings.
- Each line is a `<p>` whose class is its element: `sp-heading`, `sp-character`, `sp-paren`, `sp-dialogue`, `sp-transition`, `sp-shot`. Action has no class.
- Page breaks, page numbers, (CONT'D) and the gray suggestions come from `data-pg`, `data-fill`, `data-contd` and `data-ghost` marks. `captureBody` strips them. Never save them.
- Lengths in `styles.css` are in em of the script's type (51em = 8.5in, 1em = one 12pt line), so a line wraps the same on screen, in the off-screen measuring room and in the PDF. `spPaginate` places the pages from the line counts.
- `data-newpage` on a line is the writer's own page break (right-click → Page Break Here; Backspace at the line's start removes it). Unlike the screen marks it is saved, and it travels as `===` in Fountain and `StartsNewPage="Yes"` in Final Draft.
- A script's style lives in its `book.json`: `underlineHeadings: true` (Format → Underline Scene Headings) and `contd: false` ((CONT'D) turned off).
- A script exports as a PDF (letter, printed with `print: 'screenplay'`), Fountain or Final Draft (`.fdx`). The book formats don't apply.
- A `.fountain` or `.fdx` file dropped on a shelf or picked with Import becomes a new script. `importFile` in `main.js` only reads the file; `spFromFountain` and `spFromFdx` in `app.js` sort it into elements. Both readers are plain string functions, so the tests cover them (`scripts/fixtures/` holds a Final Draft file written by screenplain, an outside tool).

## Scribe's Log

Each book's log lives in its `scribes-log/` folder: `log.json` (made once) and one `.slog` chunk per session per device. `main.js` holds one `slog.Recorder`; every chapter, aux, json and book.json handler tells it what it read or wrote (`slogTap`, which never lets a logging failure stop a save). The window describes how text changed through `window.neo.slog.observe` before it saves; a save it didn't describe is still logged, as `unlogged`. Text found on disk that this process didn't write is `arrived`. `book.json`'s `scribesLog: false` switches a book's log off.

- The device id and each book's cached state live in `userData/slog/`, never in the library.
- `node scripts/slog-check.js "<book folder>" [--bitcoin]` (or an export's `.zip`, or an archive) checks every chain, replays it against the files on disk, traces origins across devices, and checks every receipt (against FreeTSA's root in `certs/`), what the receipts cover, and the clock. `--bitcoin` checks finished OpenTimestamps proofs against their blocks at mempool.space.
- Text that arrives from another device is traced to that device's chain: the Recorder adds a `{dev, n, doc, at}` source when the other device's chunks are already in the folder (`_arrivedFrom`), and the checker matches the rest by their words.
- The window's side is the SCRIBE'S LOG section of `app.js`. A key, click or menu command opens a typed burst; it's described after a second's pause or two seconds' run, and every save describes its document first (`slogNote` in `persistChapter`, `flushAux`, `runSidecar` and `writeBookMeta`). Paste, drop, cut and copy are labeled by capture listeners, and every `snapshotStructure` label maps to a cause (`slogCauseOf`). A new tool that changes text over an `await`, or without a key, click or snapshot, needs `slogWith(label, fn)` or its words log as `unlogged`.
- `npm run test:slog` (Electron; `xvfb-run` without a display) writes a book the way a writer does and checks its log has no `unlogged` entries.
- `npm run test:devices` (`scripts/devices.e2e.js`, plain Node starting Electron once per run) is two computers on one library, as Google Drive would sync it: NEO runs as A, as B (its own app data, so its own device id), and as A again, then the verifier checks the exports and matches the .txt and .docx. It checks text keeps its origin across computers, a version named on one computer is in the other's History, each computer plays a chapter back across both chains (the verifier plays the export too), every session's end is stamped as NEO quits (by the window's close button, by File → Quit with a book open, and by File → Quit from the shelf), and that NEO exits. `--live` uses FreeTSA and the OpenTimestamps calendars instead of the fakes.
- Pocket's bridge has no `slog`, so nothing in the window logs there.
- Duplicate (`book:duplicate`) doesn't copy `scribes-log/`: the copy's log starts at once (`Recorder.copied`), its words a baseline whose `from` names the original's log.
- Outside timestamps: `slog-stamp.js` (`Stamper`, started with the app by `slogStampsStart`) is the recorder's `watcher`. It stamps each open chain's newest entry every 15 minutes if it moved, and every chunk's `close`, with FreeTSA and the OpenTimestamps calendars over `net.fetch`; receipts go to `scribes-log/stamps/*.stamps`, `stamp` entries into the chain (or the device's next chunk), and what waits (offline queue, stamp entries, pending proofs) to `userData/slog/stamps.json`. File → Scribe's Log shows the last timestamp under the checkbox.
- `NEO_SLOG_STAMPS=off` stops stamping (the tabs, words and caret e2e set it); a JSON object points it at other services (`slog.e2e.js` runs local fakes from `scripts/stamp-fakes.js`, which sign real tokens with a test key).
- `scripts/stamp.test.js` and `scripts/slog-stamp.test.js` run on fixtures in `scripts/fixtures/stamps/`; `node scripts/stamp-live.js [folder]` tries FreeTSA, the OpenTimestamps calendars and the block explorers for real (behind a proxy, with `NODE_USE_ENV_PROXY=1`).
- File → Scribe's Log is a submenu: Log This Book (the checkbox), the last timestamp, Verification Report… (below), Export for Verification… (`slog:export`; the window's `slogExport` asks which kind, says what each holds, saves everything and sends the hashes of the lines NEO's exports add, `slogAddedLines`) and Merge Log into Archive (`slog:archive`). Anything that lists a log's files goes through `slog-files.js` (`listLog`), never `readdir` on `scribes-log/`, so archived chunks and receipts are found.
- `scripts/slog-archive.test.js` covers zips, archives (read, merged, carried on from) and exports.
- File → Scribe's Log → Verification Report… (`slog:report`; the window's `slogReport` asks how exactly to show times and whether to add a PDF) closes the session and stamps its end like an export, checks the log, and writes `slog-report.js`'s page; the PDF is the page printed by an offscreen window (`slogReportPdf`). `scripts/slog-report.test.js` covers the counting and the privacy settings. A Tracer made with `detail` (only the report does) keeps, per unit, the hour it was written, its paste, whether it was moved and whether it's markup; the default origins stay plain categories.
- The verifier (`verifier/`): `slogVerifierPage` in main.js builds it into every export with `verifier/build.js`, so it's always this NEO's checker (and player: Watch a chapter being written, for an export with the text); `npm run build:verifier` writes `verifier/verifier.html` (not committed) to try it in a browser. Its scripts are inlined with every `<` that could end a `<script>` written as `\x3C` (`scriptSafe`). Everything shown from a log goes in as text, never markup. It trusts only `certs/*-root.pem`. Its only network use is Check against Bitcoin (mempool.space, then blockstream.info), held to that by its Content-Security-Policy. `scripts/verifier.test.js` covers manuscripts, sorting, the summary and the build; `npm run test:verifier` (`scripts/verifier.e2e.js`) drives the page in a window with the network stopped; `slog.e2e.js` matches NEO's own .txt and .docx with it.
- `captureBody` leaves the engine's style spans out of what's saved (`dropJunkSpans`); the page keeps them until the chapter is next opened, because taking them off at once breaks ⌘Z.

## Versions

"Versions" on screen, never "snapshots" (that's the ⌘E email PDF, and `snapshotStructure` in the code). A chapter's past versions are rebuilt from the log (`slog-history.js`); what the log can't hold lives in the book's `versions/` folder. None of it is part of the log: no checker reads it, and it never goes in an export or the report.

- `versions/<UTC>-<dev8>.json` is a named version, written once: `{ v: 1, name, at, dev, auto, n, h }` with the log on (that computer's chain at entry `n`, whose hash `h` must match when it's rebuilt), or `{ …, copy }` naming a whole-book copy with it off. `auto` is null for one the writer named, or `restore`, `replace`, `word` for the ones NEO makes. Renaming rewrites that file; deleting removes it (and a whole-book copy only it names).
- `versions/<UTC>-<dev8>.json.gz` is a copy: `{ v: 1, at, dev, all, order, titles, chapters: { id: html }, gone: [id] }`. With a book's log off (or unreadable), `main.js` tells `SessionCopies` which chapters were saved or deleted (`chapter:write`, `chapter:delete`); when the session ends (the book closed, NEO quit, 30 minutes with no saves, the log switched back on) the chapters that differ from their newest session copy on any computer are copied, once. A named version with the log off copies every chapter (`all`).
- `history.mark(bookId, name, auto)` in `main.js` names a version (the Recorder's `head` flushes the log first). File → Name This Version… (`history:mark`; the window's `nameVersion` saves everything first). `history:named`, `history:rename`, `history:remove` are for the History window.
- View → Chapter History… (⌘⇧H; `showHistory` in `app.js`, `#chapter-history`): the window saves everything, then `history:list` (the log flushed, then `History.list` in `slog-history-worker.js`, plus `me` and the session being written, `current`) and `history:text` for each version it shows. Left, the chapter's versions newest first (named versions are listed with every chapter they hold); right, Read (`SlogDiff.viewHtml`) or Compare with the chapter now (the window's own `chapterHTML`) or another version (`SlogDiff.compare`/`toHtml`: `<del>`, `<ins>`, folds). A picker lists the book's chapters, then the chapters no longer in it. Named versions are renamed and deleted there; Copy, and Restore This Version (or Restore as New Chapter for one no longer in the book), are beside them. It owns the keyboard while it's the topmost dialog. Pocket's bridge has no `history.list`, so no window and no shortcuts-sheet row there.
- Restoring (`history:restore`, `historyRestore` in `main.js`): the window saves everything, then main flushes the log, asks the helper for the version's chapter and what this computer's chain deleted since that version (`restoreSource`: from the version's own entry, or for another computer's version or a copy, this chain's last session to change a chapter and end by its time; only deletions with words in common with the version), hands those to the Recorder (`restoring`), and, for a whole-chapter restore, names a version of the book as it stands (`auto: 'restore'`, "Before restoring Chapter 3 (Oct 8)"). The window then puts the text in under `slogWith({ src: 'move', cause: 'restore' })` and a `snapshotStructure('restore')`, with `breakRun` raised so ⌘Z from inside the text undoes it. The Recorder looks for a restore's words in those deletions after this session's own and before the book as it stands, and fills what's left over from them in short stretches (`fillFromPast`), so restored text keeps its origin; nothing is ever taken as typed. Restore as New Chapter puts a chapter no longer in the book back under its own id (its history carries on), title and old place (`was.after`, else the end). Copy in the window (or ⌘C there) marks NEO's clipboard as from history (`historyCopied`), asks main to get the log ready the same way, and the paste is labeled as a restore.
- Restore All Chapter Titles (below) shows only on a named version whose titles differ from the book's now (`showTitlesButton`).
- Chapter titles in versions (phase 4): `History.versionTitles(dir, ref)` (`history:titles`) gives a version's titles, `{ titles, ids }`: the `book` document rebuilt at its entry (its `chapterTitles`), or a copy's own `titles` (a session's copy knows only the chapters it holds). The window shows the chapter's title then above Read (with the title now, when it differs) and Compare (struck and underlined, older first); Restore This Version puts the title back too when it differs, in the same step; Restore as New Chapter uses it. A named version has Restore Titles: every chapter still in the book (and in the version) gets its title as it was then, one `snapshotStructure('restore titles')` under `{ src: 'move', cause: 'restore' }` (`historyRestoreTitles`). Chapter order, parts and the rest of `book.json` aren't restored.
- Play (the History window's third mode, beside Read and Compare): `history:playback` flushes the log and the helper's `History.playback` reads every chain whole, matches arrivals by their words, and builds one chapter's playback (`slog-playback.js`) from the selected version (`{ dev, n }`, a named version's entry too) to the log's end, or from the chapter's start for the newest version or a copy kept with the log off; it comes back as data (`toData`, a few MB for a long chapter) and the window plays it (`Playback.fromData`, `mount` with NEO's `t`, `.pb-page` styled as `.hv-page`). The player's keys reach it through the window's own key handler (`st.player.key`). Restore and Copy step aside while it plays.
- `scripts/slog-verify.test.js` checks the rule through `checkLog` with and without the words: text pasted, revised, deleted and restored is still pasted, and the same for typed, moved and arrived text.
- Duplicate leaves `versions/` behind, as it does `scribes-log/`: the copy's history starts at the copy. Nothing that reads a book's documents looks in `versions/`; the daily backup zips it with the rest of the book.
- `scripts/slog-history.test.js`, `scripts/slog-diff.test.js` and the versions tests in `scripts/slog-main.test.js`; `slog.e2e.js` names a version and checks the log-off stretch's copy; `npm run test:history` (`scripts/history.e2e.js`, Electron) drives the History window (`NEO_TEST_SHOTS=<folder>` saves pictures of it).

## Find and replace

The FIND & REPLACE section of `app.js` (⌘F, `#searchbar`, at the top of the window). Highlights only, through the CSS Highlight API: nothing goes into the chapters until a replace.

- Each root Find searches (`searchRoots`: the chapters in order, each title first when Include chapter titles is on; or the Notes page, the outline's lines, Darlings) is read as stretches of text (`findBlocks`: a paragraph's text with where each text node starts in it; a new paragraph or a `<br>` starts a new stretch), so a phrase is found across inline formatting but never across a paragraph break. `findMatchAt` turns a hit into a Range and says whether it `crosses` formatting (its text nodes carry different inline styles, `findStyleOf`).
- `findPattern` is the words as typed (never a regular expression), any case unless Match case; Whole word uses Unicode letters, digits and marks, and an apostrophe between letters joins a word ("don" isn't found in "don't"). The three options are `library.findCase`, `findWord`, `findTitles`, kept per computer (`DEVICE_LOOK`); the toggles' glyphs are drawn in CSS so they aren't taken for words to translate.
- Replace and Replace All stay in the manuscript (and its chapter titles, when Include chapter titles is on) and honor the options. `replaceHits` does every replacement: the hits grouped by stretch and edited from the last back (`findSplice`: the new words in the formatting where the hit starts), as one `snapshotStructure('replace')` or `('replace all')`, both logged as `{ src: 'typed', cause: 'replace' }`. A replacement goes in by the offsets found at search time, so a hit is only replaced while its stretch's text is unchanged (`findStillThere`); Replace and the list's decisions find stale hits again first (`findFresh`, by where their live ranges now start). `replaceHits` does nothing outside the manuscript, and Replace All checks the tab again after its awaits. A title goes through NEO's own title change (`book.chapterTitles`, `saveMeta`, a `book` edit with `keys: ["chapterTitles"]`), so ⌘Z takes titles and text back together.
- Replace All names a version of the book first, every time (`history.mark(bookId, "Before replacing ‘colour’ (Oct 8)", 'replace')`, after `slogSaveAll`), finds again, and stops if the version can't be saved; Pocket has no history, so no version there. Its toast says how many, how many in titles, how many were left, and the version's name.
- A hit that crosses formatting is never replaced blind. Replace All leaves it and opens the list on it (`findShowCrossing`); Replace asks (`findAskHow`); in the list each such hit has Keep formatting and Plain (K, P), and their heading has both for all of them (⇧K, ⇧P; `findDecide`). Keep formatting: word by word when the counts match (`findReplaceKeep`), else all in the formatting where the hit starts. Plain: the styled element is split where the hit was and the new words go in between (`findReplacePlain`). Styled elements left empty go (`findTidy`, never a span NEO marks with a class or `data-sid`).
- The results list (List in the bar, `toggleFindList`): every hit as a line of context (`findContext`, about 40 characters each side, cut between words), the rows from `findRows` (in the manuscript, hits that cross formatting first under their own heading, then each chapter's under "Chapter 3 — The Harbor" with a title's hit first; elsewhere one heading). Below the bar by default, as wide as the page column; Dock moves it into the right-hand pane over Notes & Comments (`placeFindList`: the pane held open and the page moved over as if pinned, the bar moved over with it; Undock, closing Find or dropping a note puts the pane back as it was; while it's docked the pane isn't a drop target for the Outline's cards). Where it was last is `library.findDock`, per device. Hidden until asked for, every time Find opens. Rows have fixed heights (`FIND_ROW_H`) and only those in view are drawn (`findWindow`), so 5,000 hits stay fast. Keys: ↓ from the Find box into the list (a listbox with `aria-activedescendant`), ↑ ↓ Page Home End move, Enter goes (as ↑ ↓ in the bar do), Esc back to the box. A click keeps the keyboard in the list, docked too (the chrome's mouse-up blur passes over `#find-results`), and a press doesn't redraw the lines under the pointer (`findList.pressing`), or the click would be lost. The hits that cross formatting are headed "Mixed formatting". An edit on the page while it's up finds again after a pause, keeping the hit and the scroll (`refreshFindKeepingPlace`). Desktop and Pocket alike, though Pocket has no Dock.
- The bar: Tab and Shift+Tab go round it and its list (`findTabStops`), never into the book; Esc is the way to the page. Each box has a ✕ that shows while it has something in it (`findShowClears`; not a Tab stop). A hit gone to lands two lines below the list while it's open under the bar (`findHitTop`), else a little above the middle.
- `scripts/find.test.js` (the pattern, the context, the rows and the drawing window, in `vm`); `npm run test:find` (`scripts/find.e2e.js`, Electron) drives the bar, the options, a phrase across italics, titles, the results list in both places (grouping, keys, docking and the pane put back, a 5,000-hit book), Replace and Replace All (the version named first, Keep formatting and Plain from the bar and the list, titles), titles in Chapter History and Restore Titles after a "restart", and checks the log.

## Manuscript format

File → Export → Manuscript Format… (phase 5; MANUSCRIPT FORMAT in `app.js`, the pages in `manuscript.js`) writes the book the way agents and editors ask for it (Shunn's novel format): a title page with the writer's contact block, "about 90,000 words" (`roundWords`: to the thousand from 10,000 up, else the hundred) and the title and byline halfway down, no header; then the story numbered from 1 under "Surname / TITLE / page", double-spaced 12 point Times New Roman (or Courier), one-inch margins, every paragraph indented half an inch, each chapter on a new page a third of the way down, `#` for scene breaks, parts on their own page, an epigraph kept, END at the close. The copyright, dedication, contents, acknowledgments and about pages stay out. One story with no chapters gets the short-story layout (title halfway down page 1, the text under it, the header from page 2).

- **.docx** (`docxEntries`): the title page is its own section with no header, the story the next one with `pgNumType start=1` and a PAGE field in `header1.xml`; a short story is one section with `titlePg` and an empty first-page header. A `settings.xml` keeps Word out of Compatibility Mode. Saved through `export:save`.
- **PDF** (`html`): one page for Paged.js, the header in `@page`'s `@top-right` margin box, `@page titlepage` without it; `print:manuscript` lays it out with `renderPaged` (the story's first section is `.pg1`, so it's page 1) and saves it. It shares the print window with the paperback, so each refuses while the other runs. Courier Prime (bundled) goes into the PDF; Word gets Courier New.
- The dialog remembers the contact block for every book (`library.manuscript`: name, address, phone, email, font, end; plain fields in `library.json`, never in a log, export or report) and the byline and header for this book (`book.manuscript`, only where they differ from NEO's own choice). "Anonymous" is never taken for a byline. Values go into the fields from code, so a quotation mark can't cut one short. It never opens over another dialog or twice. Scripts have their own PDF; Pocket has no manuscript export.
- `scripts/manuscript.test.js`; `npm run test:manuscript` (`scripts/manuscript.e2e.js`: the dialog, both files, the .docx read back by NEO's import, the PDF's pages read back with `pdftotext` where it's installed).

## Paperbacks for KDP

Export → Paperback for KDP… (also on the shelf's right-click Export) writes a print interior PDF and a cover template PDF beside it. `printPaperback` and `buildPrintHtml` are the PRINT BOOK section of `app.js`; `makePaperback`, `renderPaged` and `kdpCoverHtml` are in `main.js`, behind `print:paperback`.

- Trims are KDP's four most-used: 5×8, 5.25×8, 5.5×8.5, 6×9 (`PRINT_TRIMS` in `app.js`, `KDP_TRIMS` in `main.js`). Paper thickness, page limits and the inside-margin bands (`kdpGutterMin`) come from KDP's help pages; NEO adds a quarter inch to the minimum. If the page count crosses a band, the book is laid out again with the wider margin.
- Pages are set by Paged.js (`print/paged.polyfill.js`, vendored, MIT) in one offscreen window per export. A hidden window stalls its animation frames; a second offscreen window opened right after one closes fails. The window closes when the export ends. One patch in it is marked `NEO:` (a word hyphenated across a page turn broke a letter late).
- Hyphenation is soft hyphens put in by `hyphenateHtml` in `main.js` with TeX patterns (`print/hyphen/`, ISC), because Chromium only hyphenates on macOS. Only `p.hy` prose is touched; names (capitalised words, except in German) and a paragraph's last word stay whole.
- Chromium rounds page sizes to 0.01 in; `exactPageBox` rewrites the MediaBox to the exact size in the same number of bytes.
- The page count is kept even. Chapters open on a right-hand page; blank pages carry no head or number.
- Choices are kept: trim, paper, ISBN and fiction notice in `book.print`; on the pen name, `author.print` holds the back-matter links, `alsoByText` (the writer's own list, one title per line) and `reviewText` (own wording, with `{title}` for the book's title; empty means NEO's translated wording). A dedication typed in the dialog becomes the book's own Dedication page.
- Page 1 is the story's first page (the first `chapter` section, so a prologue). In the paperback that section is `.pg1` and each page's number is set on it after layout. The regular PDF stops counting on `@page front` pages and numbers its contents from the `data-p1` link; pages after page 1 that show no number (a part's title) are `.page.counted`.
- `scripts/print.test.js` covers the margin bands, hyphenation, the page box and the cover's size. Pocket has no paperback export.

## Per device

How NEO looks belongs to each device: `DEVICE_LOOK` in `app.js` (page theme, brightness, zoom, type size, typewriter, focus, counters, outline view, vim keys). Every library write also keeps them in this device's `localStorage`; every library read takes them back from there (`applyDeviceLook`). The library's copy is the last device's, which is what a device new to the library starts with. Zoom is per device and per view: the page per mode, the cards, and the shelf (`neo.shelfZoom`, ⌘+/− and pinch on the shelf), each in `localStorage`; the page moves in tenths. The desktop also keeps its page theme in `settings.json` for the window's color at launch, and `exportFolder` there, so save dialogs open where the last export went.

The right-hand pane (Notes & Comments, Find's docked list, the loose cards) is as wide as `--side-w`: dragged by its left edge (`#side-resize`, shown while the pane's open), double-click for the usual 250px, between 200px and 42% of the window, kept in `localStorage` (`neo-side-width`). The page column, the docked find bar and the Outline's cards move over by it. Not on Pocket (no hover).

The toast (`#hint`) is the opposite of what's under it: a light pill on Night's page and on a dark room (Paper's shelf and cards), a dark one on Paper's page and in Light; each pair 12.8:1 or more against what it sits on.

A book's right-click on the shelf is a small menu (`popMenu`) on the desktop, with the cover's choices one level in; touch keeps the larger cards. Duplicate (`book:duplicate`, and `duplicateBook` in Pocket's bridge) copies the folder under a new id and title.

Pocket makes PDFs through `NeoPdf`, a native plugin in each project: Android opens its print screen (Save as PDF), iOS draws the pages into a file for the share sheet. A script's title can be set bold, underlined or italic as a whole (`book.titleStyle`, ⌘B ⌘U ⌘I on the title page), and keeps it in the PDF, Fountain and Final Draft.

## Processes

```
index.html + app.js  →  preload.js (window.neo)  →  main.js  →  NEO Library
                                                      ↓
                                               spell-worker.js
```

The window is created with `contextIsolation: true` and `nodeIntegration: false`. New renderer capabilities are added in three places: an `ipcMain.handle` in `main.js`, a method on `window.neo` in `preload.js`, and the call site in `app.js`.

## Files on disk

Default library: `~/Documents/NEO Library` (`app.getPath('documents')`). **File → Library Folder…** stores another path in `userData/settings.json` and restarts. NEO does not move existing books.

```
NEO Library/
  library.json          shelves, author, pen names, customWords, spellLanguage
  _catalog.txt          regenerated map of folder → title; edits are ignored
  neo-errors.log
  Backups/neo-backup-YYYY-MM-DD.zip    one per day, 14 kept
  Exports/              emailed PDF snapshots
  book-<slug>-<id>/
    book.json           metadata and chapterOrder
    chapters/<id>.html
    notes.html
    outline.html
    darlings.json
    stickies.json
    cover-<ts>.<ext>    writer-chosen image
    art-<ts>.<ext>      painted image, plus art.json
    scribes-log/        the Scribe's Log (SLOG-FORMAT.md)
    versions/           named versions and log-off copies (see Versions)
```

App settings and the cover-art API key live in Electron `userData` (`settings.json`, `secrets.json`), not in the library. The key is encrypted with `safeStorage` when the OS allows it. Do not write secrets into the library.

Every book id, chapter id, and sidecar name passes through `libName()` in `main.js`. It allows one path segment and rejects `.`, `..`, slashes, and null bytes. Keep new files inside that helper.

Every library write goes through `writeFileDurable`: `file.tmp`, fsync, then rename into place, so a power cut can't leave an empty file. `writeJSON` also keeps the last version that read whole as `file.bak`, and `readJSON` falls back on `.tmp`, then `.bak`. A `book.json` lost with no copy is rebuilt from the chapter files (`rebuildBookMeta`). There is no append and no partial chapter update.

`json:write` and `aux:write` will create any single-segment `<name>.json` or `<name>.html` in the book folder. Prefer the existing names unless a new sidecar is actually required.

## Saving and sync

The window holds the open book in memory (`chapterHTML`, `book`, `stickies`, `darlings`) and remembers what it last wrote (`savedHTML`, `savedMetaSig`).

- Chapter and notes edits debounce 800 ms, then write only if the HTML changed and the chapter is still in `chapterOrder`.
- `flushAllSaves` runs every 20 s and on blur, hide, and close. It also stores `lastPosition` in `book.json`. A scroll-only change is not a new position.
- `refreshFromDisk` runs on focus, on visibility, and every 30 s while visible. It compares `mtimeMs:size` stamps and re-reads only changed chapters.
- Unchanged local chapter plus a changed file: adopt the file. If the file only has fewer words, adopt it and keep the displaced text in Darlings.
- Both sides changed: keep the local text on the page and insert the disk text as the next chapter, titled as from the other device.
- Skip a chapter whose write is still in flight. Drop a read that overlapped a local save. An empty read must not wipe a chapter that already has text.
- The same generation check applies to `library.json` on the shelf (`libraryGeneration`, `libraryWritesPending`).

Do not replace this with last-write-wins. The comments in `persistChapter` and `refreshFromDisk` explain cases that look redundant and are not.

## Interface language

Wrap writer-visible strings in `t('English text', { placeholder })`. Use `tk()` for strings translated later, at the point of display. In `index.html`, use `data-i18n`, `data-i18n-title`, `data-i18n-placeholder`, or `data-i18n-ph`.

After adding or changing strings:

```
node scripts/i18n.js template
node scripts/i18n.js check fr
```

`scripts/i18n.js` only scans `app.js`, `main.js`, `covers.js`, `slog-report.js` and `slog-playback.js` (whose `t` is passed in: NEO's, or plain English in the verifier), `index.html`, and Pocket's own `pocket/www/index.html` and `pocket/www/pocket-bridge.js`. A new string in another file will not enter the template until that list includes it. Pocket's page marks its words with the same `data-i18n*` attributes as the desktop's, and its ⋯ sheet and bridge use `t()`.

Details, plural forms, and regional fallback (`fr-CA` → `fr` → English) are in [TRANSLATING.md](TRANSLATING.md). Quotation marks follow the spellcheck language (`QUOTE_STYLES` in `app.js`). Import chapter detection is `CHAPTER_WORDS` in `main.js`. Cover small-words are `CONNECTORS` in `covers.js`.

Italian has no spellcheck dictionary: the only Hunspell package on npm is GPL-3.0-only, and NEO is MIT. Do not add it.

## Pocket

`pocket/` is a Capacitor app that runs the desktop editor. Its bridge (`pocket/www/pocket-bridge.js`) implements `window.neo` against the phone's library folder. Android shares `Documents/NEO Library` via sync. iOS uses the app folder, optionally iCloud, with `LibraryHome.swift` locating that folder.

`scripts/pocket-www.js` (run by CI, and by hand before a local build) copies `app.js`, `covers.js`, `styles.css`, `i18n.js`, `fonts/`, `locales/`, Hunspell's browser build, and the `SPELL_LANGUAGES` dictionaries from `main.js` into `pocket/www/`. Pocket's checker is `pocket/www/pocket-spell.js`, a module worker with the same messages as `spell-worker.js`. A change to those files changes Pocket. Pocket-only behavior belongs in `pocket-bridge.js` or the native projects, not behind a desktop-only branch scattered through `app.js`.

## Commands

```
npm install
npm start
npm test                   # node --test scripts/*.test.js
npm run test:coverage      # node --test --experimental-test-coverage scripts/*.test.js
npm run lint               # oxlint, Electron's standard-style JavaScript rules
npm run test:spellcheck    # node --test scripts/spellcheck.test.js
npm run test:dashes        # node --test scripts/dashes.test.js
npm run test:verifier      # the verifier page, in Electron (xvfb-run without a display)
npm run test:devices       # two computers on one library, end to end (add -- --live for the real services)
npm run test:history       # the History window, in Electron (xvfb-run without a display)
npm run test:find          # Find and Replace, in Electron (xvfb-run without a display)
npm run test:palette       # the command palette, in Electron (xvfb-run without a display)
npm run test:manuscript    # Manuscript Format export, in Electron (xvfb-run without a display)
npm run build:verifier     # writes verifier/verifier.html
npm run bundle             # Hugh: brings in the newest .bundle from ~/Downloads and pushes main
npm run release            # Hugh: next version (x.y.9 → x.(y+1).0), commit, push, tag (npm run release -- 2.0.0 for another)
npm run package:mac        # macOS build; npm run package calls this
npm run package:linux      # AppImage via electron-builder; also package, package:mac, package:win, package:all
```

Tests use `node:test` and load `app.js` or `spell-worker.js` inside `vm`. They are not run by CI. The only CI check is a Windows smoke test that the packaged exe boots and creates a library (`.github/workflows/build.yml`, on `v*` tags). Pocket builds from `.github/workflows/pocket.yml`.

`node scripts/history-bench.js [sessions] [entries per session]` times versions, playback and the verification report on a synthetic novel-length log (600 sessions, 200,000 entries by default). `node scripts/check-romanian-package.js <Resources dir>` compares a packaged app's dictionaries to the source tree. `node scripts/benchmark-spellcheck.js` times the checker. Neither is an npm script.

## Handing changes to Hugh

Hugh pushes and releases himself and isn't a git user. Hand him work as a git bundle of main..your-branch, built on the latest origin/main, then tell him: save it to Downloads, `npm run bundle`. To ship a desktop release: `npm run release`. Both commands check their footing and stop with a plain sentence instead of half-finishing. Don't give him raw git or npm version steps when these cover it.

## When you change something

- A new filesystem operation needs a handler, a `libName()` boundary, and a `preload.js` method. Match the existing IPC names (`library:`, `book:`, `chapter:`, `aux:`, `json:`, `cover:`).
- A new writer-visible string needs `t()` and a template refresh.
- A new way to remove text needs a recovery path and a sentence in the UI that says where the words went.
- Export formats are assembled in `app.js` and written by `export:save` in `main.js`. EPUB is a zip built in memory. PDF is printed from temporary HTML.
- Errors in the main process are appended to `neo-errors.log` via `logError`. Renderer failures go through `window.neo.logError`. Do not swallow a save failure; `persistChapter` rolls `savedHTML` back so the next flush retries.

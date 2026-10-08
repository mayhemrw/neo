# Scribe's Log format, version 1 (draft)

The Scribe's Log is a tamper-evident record of how a book was written in NEO. This document defines the files well enough for anyone to write their own checker. NEO's own implementation is `slog.js` (writing) and `slog-verify.js` (checking, shared by NEO, `scripts/slog-check.js` and the standalone verifier).

Draft status: the parts below are implemented and tested. Signatures are reserved and will be specified when they're built.

## What it can and can't show

A log can show that it hasn't been altered since each outside timestamp, that the writing happened over the dates shown, which text was typed in NEO, moved within the book, pasted from outside, or imported, and that it ends in exactly a given manuscript.

It can't show that a human pressed the keys, that the ideas weren't a machine's, or anything about writing done outside NEO. It's process evidence, not proof of authorship.

## Files

Each book folder holds a `scribes-log/` folder:

- `log.json`: `{ "v": 1, "logId": "<16 hex>", "key": "<32 bytes, base64>" }`, written once. The key salts text commitments. It's never included in a log shared without its text.
- Chunk files, `YYYYMMDDTHHMMSSZ-<8 hex>.slog`: one session on one device. The time is the session's start in UTC; the hex is the first 8 characters of the device id. A name already taken gets `-2`, `-3`, and so on before `.slog`. Names sort by time, but chain order is decided by links (below), never by names.
- `stamps/`: outside timestamp receipts (see Outside timestamps), in files named like chunks but ending `.stamps`, and `stamps/certs/<sha256 of the certificate>.der`, each certificate the receipts are checked with, once.
- `archive-YYYYMMDDTHHMMSSZ-<8 hex>.zip`: closed chunks and receipt files merged into one file (see Archives). The time is when it was made, in UTC; the hex, the device that made it.

A device id is 128 random bits, made once per installation. It's never derived from hardware.

A chunk is started only when there's something to record, so opening a book to read it writes nothing. It ends when the book closes, NEO quits, the writing stops for 30 minutes, the log is switched off, or it reaches 8 MB; the next entry starts a new one.

NEO also keeps, on each computer and outside the library, a cache of where its own chain stands. It isn't part of the format: without it, NEO reads its chunks back.

## Chunks

A chunk is JSON Lines: UTF-8, one JSON object per line, each line ending in `\n`. A final line without `\n` is a write cut short by a crash or power loss: readers ignore it, and it isn't damage. A chunk is appended to only while its session lasts and never changes after its `close` line.

The first line of every chunk is an `open` entry. A chunk normally ends with a `close` entry; one that doesn't is a session that ended without closing (NEO quit unexpectedly), which is noted but isn't damage.

## Entries

Every entry has a **clear part** and, while it's on the writer's computer, an optional **words part** `x`.

- The clear part is every field except `x`. It's what the chain hashes, and it's all a log shared without its text contains. Nothing in the clear part can ever be removed from a shared log without breaking the chain, so it holds no text, titles, file names, time zones or hardware details.
- `x` is `{ "ins": [ <string>, … ] }`: the words each op inserted, one string per op (empty for an op that only deletes). It's present only when the entry inserted text.

### Fields every entry has

| Field | Meaning |
|---|---|
| `kind` | One of the kinds below |
| `n` | Position in this device's chain, starting at 1 and rising by exactly 1, across chunks |
| `prev` | Hex SHA-256 of the previous entry in this device's chain; `null` only for `n: 1` |
| `ts` | Milliseconds since 1970-01-01 UTC, from the device's clock |

### Kinds

| `kind` | Meaning | Fields |
|---|---|---|
| `open` | Starts a chunk | `v` (format: `2`, or `1` for a chunk with no `stamp` entries written before them), `log` (log id), `dev` (device id, 32 hex), `prevChunk` (name of this device's previous chunk, or `null`), `app` (NEO version, then `+slog1`) |
| `edit` | One burst of changes to one document | `doc`, `src`, `ops`, `c` if text was inserted, and optionally `dur`, `ev`, `cause`, `from`, `keys` |
| `base` | A document's whole text, with no process record behind it | `doc`, `src` (`baseline`, `import` or `arrived`), `ops` (a single `[0, 0, length]`), `c`, optionally `file` or `from` (another book, or another device) |
| `doc` | A document created or deleted | `doc`, `act` (`new` or `del`). A deleted document's text is first deleted by an `edit`, so a later move can point at it |
| `on`, `off` | The log switched on or off for this book. `off` is followed by the chunk's `close`; after `on`, whatever changed while the log was off is recorded with `cause: "off"` | |
| `sleep`, `wake` | The computer went to sleep or woke | |
| `clock` | The wall clock jumped against the computer's steady clock | `jump` (ms, negative for backward) |
| `close` | Ends a chunk | `why` (`close`, `quit`, `idle`, `off`, `size`, `error`), `ms` (manuscript hash) |
| `stamp` | An outside timestamp's receipt arrived | `svc` (`freetsa` or another RFC 3161 service, or `ots`), `of` (the entry stamped, on this chain), `r` (SHA-256 hex of the receipt: the token, or the proof as first kept), `t` (the token's time, RFC 3161 only) |

Reserved field: `sig` (a signature, added in a later version without changing anything else).

### Documents

`doc` names a document in the book, and every edit is measured in that document's text:

| `doc` | Text |
|---|---|
| a chapter's id (`ch-…`) | `chapters/<id>.html`, exactly as saved. A chapter file named `book`, `notes`, `outline`, `darlings` or `stickies` is `ch:` plus its name |
| `notes`, `outline` | `notes.html`, `outline.html`, exactly as saved |
| `darlings`, `stickies` | `darlings.json`, `stickies.json`: the parsed list written back as JSON with two-space indents (`JSON.stringify(v, null, 2)`) |
| `book` | `book.json` without `id`, `lastPosition`, `modified`, `wordCount`, `dailyCounts`, `scribesLog`, `uuid`, `coverArt`, `coverImage`, `coverMode` or `coverSeed`, and without fields that are `null`, `""` or an empty object or list; keys sorted at every level; JSON with two-space indents |

A document is introduced by a `doc` entry with `act: "new"` or by a `base`, before any `edit` to it.

### Ops

`ops` is a list of `[at, del, ins]` or `[at, del, ins, markup]`:

- `at`: where, in UTF-16 code units of the document's text.
- `del`: how many code units are deleted there.
- `ins`: how many code units are inserted there (the length of the matching string in `x.ins`).
- `markup`: present only when the inserted text contains markup, as `[[offset, length], …]` within the inserted string, one pair for each `<…>` tag. It lets a checker without the text count visible letters.

Ops apply in order, and each `at` refers to the text as it stands after the ops before it.

### Where text came from

`src` labels every inserted string in an entry:

| `src` | Meaning |
|---|---|
| `typed` | Written in NEO |
| `paste` | Pasted from outside NEO (size and time only) |
| `drop` | Dragged in from outside NEO |
| `move` | Moved or copied from elsewhere in NEO; `from` says where, when the log could tell |
| `import` | Read in from a file. On a `base`, `file` gives that file's `mtime` (ms) and `sha256` (hex of its bytes); never its name |
| `arrived` | Written on another device and found on disk |
| `baseline` | In the book before the log began |
| `unlogged` | Reached disk without a labeled entry; origin unknown |

An edit that only deletes uses `src` for how the change was made: `typed` for the writer's own editing (the leaving half of a move included; `cause` says which tool), `arrived` for a change found on disk, `unlogged` when NEO can't say.

`cause` optionally names what in NEO made the change (`undo`, `redo`, `replace`, `outline`, `split`, `join`, `spell`, `darling`, `placeholder`, `restore`, `off`). `restore` is a past version of a chapter put back (the whole chapter, a chapter no longer in the book, or a passage copied out of a version and pasted in); its `src` is `move` (`typed` when putting it back only deletes), and its `from` points at the deletions that took those words out. A checker that doesn't know a `cause` ignores it: chunks stay `v: 2`.

### Where moved text came from

`from`, on any `edit`, says which stretches of its inserted text were already in the book, so they keep the origin they had: text deleted and brought back (an undo, a cut pasted back, a passage sent to Darlings and restored), carried from one document to another (a chapter split, a card moved), or copied. It's a list of pieces, each `[op, at, len, source]`: units `at` to `at + len` of the string inserted by op `op` of this entry came from `source`, one of:

- `{ "n": <entry>, "op": <index>, "at": <offset> }`: text deleted by op `op` of entry `n` in this chain, starting `at` units into what that op deleted. The entry can be this one, for an op at or before the piece's own (an op's deletion happens before its insertion).
- `{ "doc": <document>, "at": <offset> }`: text in that document as it stood just before this entry, at that offset (a copy, or text whose deletion is logged after this entry).
- `{ "log": <log id> }`: text from another NEO book. Where in it isn't recorded.
- `{ "dev": <device id>, "n": <entry>, "doc": <document>, "at": <offset> }`: text that arrived from another device: document `doc` as it stood just after entry `n` of that device's chain, at that offset. (Also written as a chunk `v: 2` addition; a v1 chunk never has one.)

The `{n, op}` and `{doc}` sources carry `"len": <units>` when the source's length differs from `len`. That happens only for a piece that's one character written two ways, such as `\"` in a JSON document and `"` in a chapter, or a space written as a no-break space (`&nbsp;`, `&#160;`, `&#xa0;`, the character U+00A0 or its JSON escape) on one side and a plain space on the other, as Chromium saves the space at the edge of a paste: the piece's units then all take the origin of the source's first unit. Otherwise the piece maps unit for unit.

A `base` can carry `from` too, with `{log}` or `{dev}` sources only: a book made as a copy of another (NEO's Duplicate) starts its log with its words as a `baseline` whose pieces name the original's log, so its text counts as another book's; a document that arrived whole from another device names that device's chain.

**Text from another device.** When NEO logs `arrived` text (a `base` or an `edit` with `src: "arrived"`), it looks at the other devices' chunks already in the folder. If one of those chains ends with that document in exactly the state that arrived, the entry's `from` names it: one `{dev}` piece for each op's whole insertion (or the whole base), pointing at where that string stands in the other device's document after its last entry that changed the document. If the other device's chunks hadn't synced yet, the entry has no `from`; a checker holding the words can still match it (below).

Pieces are in order of `op`, then `at`, and don't overlap. Units no piece covers take the entry's `src`; in a `move` entry, that's text moved within NEO whose place wasn't recorded.

NEO records a piece for an exact match of at least 20 units of text outside tags, so a common phrase typed again isn't mistaken for a move. (An HTML string that starts partway into a tag, as an edit's inserted string can, counts everything up to its first `>` as tag.) When the window says text was moved (a paste of NEO's own clipboard, an undo or redo, one of NEO's tools), a shorter insertion found whole counts too, and so does one of the last few deletions found whole inside it. NEO keeps the deleted text it matches against for the session only; a checker keeps whatever a `from` points at. For a `restore`, NEO also reads back what this device's chain deleted since the version being restored (from the version's own entry, or for another device's version, from this chain's last session to change a chapter and end by the version's time) and matches against that too, so restored words point at the entries that deleted them, however long ago, and keep their origin: a pasted passage restored is still pasted. Stretches of a restore too short for the rule above (a word revised before the whole passage was deleted) are matched against those deletions on their own, down to 4 units of text, the oldest deletion first.

`keys`, for edits to `book`, lists which top-level fields changed (such as `["author"]`), so a change of author name shows without the name.

`dur` is the burst's length in ms and `ev` the number of input events in it.

## Hashing

**Canonical JSON.** An object's keys are sorted by UTF-16 code unit, at every level; no whitespace; strings escaped as ECMAScript `JSON.stringify` escapes them; numbers are whole (safe integers), with `-0` written as `0`; fields whose value is undefined are left out.

**Entry hash.** `SHA-256(UTF-8(canonical(clear part)))`, written as lowercase hex. The next entry's `prev` is this value, and so is an `open` entry's `prev` when it continues a chain from an earlier chunk.

**Commitment.** For an entry with `x`:

```
salt = HMAC-SHA256(key, UTF-8(dev + ":" + n))
c    = hex(SHA-256(salt || UTF-8(canonical(x.ins))))
```

`key` is the decoded key from `log.json`; `dev` is the chain's device id; `n` is the entry's own number. Each entry has its own salt, so one entry's words can be shown later, with that salt, without revealing the key or any other entry.

**Manuscript hash.** `ms` in a `close` entry is `hex(SHA-256(UTF-8(T)))` over the manuscript as the chain that wrote it sees it. It's unsalted, so anyone holding the manuscript can compute it, and anyone replaying the log can too. `T` comes from the documents:

1. The chapters are those in the `book` document's `chapterOrder`, in that order, leaving out any whose `chapterKinds` entry is `contents`. Generated chapter headings and the title page aren't in any document, so they aren't in `T`.
2. In each chapter, every `<p>` element is a line. A `<p>` with class `scene-break` is the line `***`. Left out: a `<p>` with class `ghost` (an outline section not yet written) and the `scene-break` whose `data-sec-brk` names it, and any element with class `ghost`, `ph-mark` or `darling-anchor`, with everything inside it.
3. A line's text is the text inside its `<p>`, tags removed, `<br>` as a line break, character references decoded (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;`, `&#…;`, `&#x…;`). Lines that are empty once trimmed are left out.
4. The lines are joined with line breaks, converted to Unicode NFC, every run of whitespace (no-break spaces included) replaced by one space, and trimmed.

A manuscript exported as plain text from NEO gives the same `T` once its title page and chapter headings are taken out (a part's title, which an export prints in the part's heading, is a line of its part page here).

## Outside timestamps

**What's stamped** is an entry's hash: the 32 bytes whose hex is the next entry's `prev`. A receipt for entry `n`'s hash shows entry `n`, and every entry before it on that device's chain, existed by the receipt's time.

**RFC 3161** (FreeTSA, or any time-stamp authority): a TimeStampToken whose message imprint names SHA-256 and holds those 32 bytes. A token checks when its imprint is that hash; its signed attributes name TSTInfo as the content, carry the digest of the TSTInfo, and name the signing certificate (ESS signing-certificate, v1 or v2); its signature verifies with that certificate; the certificate is for timestamping only (extended key usage `timeStamping`, critical) and chains to a trusted root; and every certificate in the chain was valid at the token's time. Revocation isn't checked. The token's time is its `genTime`.

**OpenTimestamps**: a standard detached proof (`.ots`) whose file hash is SHA-256 and whose file digest is those 32 bytes, so `ots verify -d <hash>` checks it too. NEO's proofs start with an append of 16 random bytes and a SHA-256, which is what the calendars see. A Bitcoin attestation checks when its message equals the merkle root in the header of the block at its height (bytes 36 to 68, as stored); the block's own time then bounds the entry's.

**When.** While a book is being written, NEO stamps its chain's newest entry every 15 minutes if the chain has moved (its own `stamp` entries don't count), and at the end of each session (the `close` entry). Offline, only each book's newest unstamped entry waits, and goes when the network's back: a late stamp proves no more than one sent then.

**Receipt files** (`stamps/*.stamps`): JSON Lines, like chunks, with the same rule for a final line cut short. Each line is one receipt:

```json
{"svc":"freetsa","dev":"<device id>","n":1205,"h":"<entry hash>","ts":1791388512345,"tsr":"<base64 TimeStampToken>"}
{"svc":"ots","dev":"<device id>","n":1205,"h":"<entry hash>","ts":1791388512345,"ots":"<base64 .ots proof>"}
```

`n` and `h` are the entry stamped and its hash; `ts` is when NEO sent the request, by its own clock. A file is appended to while its session lasts and never changes once closed. An OpenTimestamps proof is kept first as the calendars' pending answer; when the calendars have put it in a Bitcoin block (hours later), NEO writes the finished proof as a new line in a new file, and the pending one stays. Receipts stand on their own: which file holds a line doesn't matter, and a reader takes every file.

**Stamp entries.** Each receipt is also recorded in the chain as a `stamp` entry: in the chunk being written, or at the start of that device's next chunk if the session had ended. A `stamp` entry names its receipt by hash, so a receipt that goes missing from `stamps/` is a visible gap. Requests carry nothing but the hash (for OpenTimestamps, a hash of it with a random nonce): no title, name, device id or text.

**Certificates.** RFC 3161 tokens are requested without certificates; `stamps/certs/` holds the signing certificate and its root, so tokens stay checkable after the certificates expire.

## Archives

A long book's log can be merged into one file: NEO's File → Scribe's Log → Merge Log into Archive, only when the writer asks. An archive is a standard zip (stored or deflated entries, UTF-8 names, no zip64) holding files at the paths they had in the folder: chunks at the top (`<chunk>.slog`) and receipt files under `stamps/`, each byte for byte as it was. Nothing else: `log.json` and `stamps/certs/` stay where they are.

A reader takes every archive and every loose file as one folder. The same path in two places must be the same bytes; when one copy is the start of the other (a sync still bringing a file, or a receipt file another device was still writing), the longer is used and that's noted; two copies that differ otherwise are damage, as is an archive that can't be read, an entry whose CRC-32 or size doesn't match, or an entry that isn't a chunk or a receipt file.

When NEO makes an archive it includes every older archive's files, so one archive holds everything merged so far. It takes:

- every closed chunk (one whose last line is `close`), any device's, since a closed chunk never changes;
- a chunk without `close` only once it's a day old, by its time on disk and its last entry (a session that ended without closing);
- receipt files no one is still writing: this device's once its stamper has closed them, another device's once they're a day old;
- never the chunk being written.

It writes the archive, reads it back from the disk and compares every file with what went in, and only then removes the loose files it holds and the older archives. A failure removes the new archive and nothing else. A device whose chunks were archived elsewhere carries on: its chain's next chunk names the archived one as `prevChunk`, as it would a loose one.

## Exports

NEO's File → Scribe's Log → Export for Verification… writes a book's log as one zip for someone else to check. First the session being written closes and its last entry is stamped (NEO waits up to 30 seconds for an RFC 3161 receipt); the manifest says whether the export ends on a stamped entry. There are two kinds:

- **No text** (`"text": "none"`): every chunk line with `x` taken off. Entry hashes cover only the clear part, so every chain still checks, every op still replays by length, and every receipt still checks. `log.json` carries `v` and `logId` but not the key. A line that can't be read can't be cleared of words, so it's replaced by a line starting `!` (still unreadable, so the damage stays visible); a last line cut short is left off.
- **Full** (`"text": "full"`): every chunk as written, and `log.json` with its key, so every commitment checks and every document replays exactly.

```
README.txt       what this is, how to check it, what it can and can't show
verifier.html    the standalone verifier from the NEO that made it
manifest.json    see below
log.json
chunks/<chunk>.slog       every chunk, loose or archived, unpacked
stamps/<file>.stamps      every receipt file, loose or archived
stamps/certs/<sha256>.der
```

`manifest.json`:

| Field | Meaning |
|---|---|
| `kind` | `"scribes-log-export"` |
| `format` | `1` |
| `text` | `"none"` or `"full"` |
| `exported` | When, ms UTC |
| `app` | The NEO version |
| `title`, `author` | The book's title and its own author name (`book.json`'s `author`, which may be empty) |
| `logId` | The log's id |
| `devices` | How many chains |
| `manuscript` | `{ "hash": <the manuscript hash as the exporting device's chain has it>, "added": [<hex SHA-256>, …] }` (below) |
| `chapters` | The manuscript's chapters in the book's order (ids only, no titles; contents pages left out), so a report on the log without its text counts the same chapters (`book.json` is among the words it doesn't have) |
| `stamped` | `{ "dev", "n", "tsa", "ots" }`: the exporting device's last entry, and whether an RFC 3161 receipt and an OpenTimestamps proof for it were in hand; `null` if that device has no chain |
| `intact` | Whether the log checked as it went out |
| `files` | `[{ "path", "size", "sha256" }]` for every file but `README.txt`, `verifier.html` and `manifest.json` |

A checker compares every file with `files` (a file missing, changed or not listed is a problem), then checks the log as for a folder. The README and the verifier page are NEO's, not the log's, and aren't listed.

**Matching a manuscript without the text.** NEO's own .txt and .docx exports add lines that aren't in the manuscript hash: the title page (title, subtitle, author, "by" and the author), headings, and a contents page. `added` holds the SHA-256 of each such line, normalized as the manuscript hash normalizes text (NFC, whitespace runs to one space, trimmed), as written and in capitals (the .txt sets headings in capitals). A checker drops the lines of a .txt or .docx whose normalized SHA-256 is in `added`, then compares the manuscript hash of what's left with `manuscript.hash`. A .docx's lines are the paragraphs of `word/document.xml`: the text of its runs (`w:t`), a tab as a tab, a line or page break (`w:br`, `w:cr`) starting a new line; deleted text under tracked changes (`w:delText`), field codes and a text box's `mc:Fallback` copy aren't text. A file that is the manuscript alone matches as it is. Limits: a paragraph that happens to read exactly like one of NEO's added lines is dropped with them (and the file then doesn't match), and a titled part's heading in the .txt is one line in capitals (`PART I: THE TITLE`) while the manuscript has the title as written, so a book with titled parts matches only through its .docx.

## Checking a log

For each device:

1. Read every chunk whose `open` names that device, loose or in an archive. Ignore a final line without `\n`, and a chunk with no complete line at all.
2. Order the chunks by links: the first has `prevChunk: null`; each next one names the one before. Two chunks naming the same predecessor is a fork; a chunk no chain reaches is unlinked. Both are damage.
3. Walk the entries in order. `n` must rise by exactly 1, and each `prev` must equal the hash of the entry before it.
4. With the key and words present, each `c` must match, each inserted string must have its recorded length, and each `markup` list must match the tags in its string.
5. Replay the ops from empty documents. Every op must fit the text it applies to. With words, this rebuilds every document exactly; without them, it still checks every length.
6. Follow every `from`: each piece must point at text that exists (a deletion earlier in the chain, or at or before its own op; a document as it stood before the entry; another device's document as it stood after the entry named, on that device's chain) and fit inside it. With words, the two stretches must be the same text, or one character written two ways (which takes the origin of the source's first unit, as above). A `{dev}` piece naming a device whose chunks aren't there, or an entry or document that chain doesn't have, is damage.

A restore needs nothing more: its pieces are ordinary `{n, op}` sources, deletions earlier in the same chain, however many chunks back.

The replayed documents of a device are the book as that device last saw it. A `close` entry's `ms` can be compared with a manuscript's hash.

### Origins

Replaying while carrying each unit's origin gives, for every unit of every document, where it first came from: the `src` of the entry that inserted it, unless a `from` piece covered it, in which case the origin of the unit it came from. A `base` gives its whole text its `src`; `unlogged` with `cause: "off"` is text changed while the log was off. Text from another book is labeled as such. Counting the units of the manuscript's chapters by origin, leaving out tags, scene breaks and the elements the manuscript hash leaves out, and counting a character reference (`&nbsp;`, `&amp;`, `&#8212;`) as one character at its first unit, shows how much was typed, pasted, imported, and so on.

Chains are traced together, since a `{dev}` piece takes the origins its text had on the other device: a checker advances that device's chain to the entry named (which, in real time, came first) and reads its origins there. An `arrived` entry with no `from` and inserted text keeps the origin `arrived`, unless the checker has the words: then it may match the entry to the first entry on another device's chain after which that document was exactly the same (same length, then same SHA-256), and treat the entry as if it had `{dev}` pieces naming it. NEO's checker does; a match that would loop between devices is dropped. Without the words, unmatched arrivals stay `arrived`. An `arrived` edit whose pieces all name the same entry of the same device, and that leaves the document the same length as that device's document then (and, with the words, the same text), takes that document's origins whole rather than piece by piece: which of two identical characters an edit kept and which it inserted is only the diff's choice (a sentence moved to just after a full stop can come out as keeping its own stop and inserting the one before it), and the other device's chain is what says which character came from where.

Reports name devices Device 1, Device 2… in order of each chain's first entry, never by the device id.

### Receipts

Every line of every receipt file is checked on its own:

1. Its `dev` and `n` must name an entry of a chain that's there, and `h` must be that entry's hash.
2. An RFC 3161 receipt checks as above (Outside timestamps), against the checker's own trusted roots; the certificates in `stamps/certs/` are used to build the chain but are never trusted for themselves. A token whose only problem is that its authority isn't one the checker trusts is *unchecked*, not damage. Its time is the token's `genTime`.
3. An OpenTimestamps receipt must be a proof of `h`. A proof with only pending attestations is *pending*. One with a Bitcoin attestation names a block and the merkle root that block must have; checking it needs that block's header (NEO's verifier fetches it only when asked), and its time is then the block's own timestamp.

Each `stamp` entry must match a receipt whose SHA-256 is its `r` (for OpenTimestamps, the proof as first kept, which stays in its file when the finished proof is written beside it), naming the same device and entry (`of`), and for RFC 3161 the same time (`t`). A `stamp` entry with no receipt is damage: a receipt was deleted. A receipt with no `stamp` entry is normal (the entry may be waiting for the device's next chunk; finished proofs never get one).

**Coverage.** A receipt that checks for entry `n` dates every entry up to `n` on that chain: each entry's outside time is the earliest such receipt's. The entries after a chain's last good receipt are dated only by the computer's clock, and a report says so. The stretch of writing between two stamps is measured in session time (each chunk's span within it), not wall time.

**Clock check.** Flagged, never fatal:

- a `clock` entry whose `jump` is more than 2 minutes back, or an entry dated more than 2 minutes before the entry before it;
- a `clock` entry more than 2 minutes forward that doesn't come within 5 minutes after a `wake`;
- an RFC 3161 receipt whose time differs from its request's `ts` by more than 5 minutes;
- an RFC 3161 receipt dated more than 2 minutes before the entry it covers (the computer's clock was ahead).

Every time is UTC, so time zones and daylight saving never flag anything.

## The report

NEO's File → Scribe's Log → Verification Report… (and the verifier, from an export) summarizes a checked log as one web page. It's a summary for reading, not something to check: the log is. NEO's is `slog-report.js`; what it counts is set out here so another checker can count the same.

- **Characters** are units of the manuscript's chapters counted as for Origins above. Without the words, a unit is counted as writing unless the `markup` list of the op that inserted it says it was a tag; that can't see scene breaks, unwritten outline sections, placeholder and Darlings marks, the part of a tag at the start of an inserted string, or a character reference as one character, so it counts a little more (on NEO's test book, 0.06%).
- **Pasted, then revised:** units of a paste op (`src: "paste"`) whose paste later had text inserted or deleted with that paste's own prose (units outside tags) on both sides. The units stay pasted; what was typed into it is typed. A paste is one op of one entry; moved, it's still the same paste.
- **Moved:** units that came to where they are through a `from` piece naming this book (`{n, op}` or `{doc}`), counted under their origin and also as moved.
- **Deleted** (revision density): units outside tags (by the `markup` lists) cut from chapters by this device's own entries (not `arrived` ones, which are another device's), less units put into a chapter through a `from` piece whose source is a chapter or `darlings` (a move, or a passage restored). Text sent to Darlings counts as deleted until it's restored. Density is deleted units per unit in the manuscript; by month, units deleted that month per unit written that month that's still there, each unit dated by the entry that first inserted it.
- **Sessions:** a chunk with at least one `edit` or `base` that isn't `arrived`. Writing time joins each such entry's `ts` to `ts + dur` into stretches, a gap over 10 minutes starting a new stretch, and adds the stretches up.
- **The timeline** counts the manuscript, by origin, as each device had it at each `close` and at its chain's last entry.
- **Times** are shown exactly, as dates, or as weeks (from Monday), in the time zone of whoever makes the report, which the page names. The setting applies to the report only; the log and its exports keep exact times.
- **Devices** are Device 1, 2… as above. The report shows the book's title, its own author name and chapter titles (from the words; without them, "Chapter 1"…), and never the text.

## The verifier

Every export carries `verifier.html`, one self-contained page built from the same checker NEO runs (`verifier/build.js` puts `slog-hash.js`, `slog-zip.js`, `stamp-tsa.js`, `stamp-ots.js`, `slog-verify.js`, `slog-report.js`, `slog-diff.js`, `slog-playback.js` and the page's own scripts inside it, with the trusted roots from `certs/`). It works from a double-click with the network off. What it does:

- **Takes** an export (zipped or unzipped), a `scribes-log` folder (or a book folder holding one), an archive with its `log.json`, or a log's files dropped one by one, and any number of manuscripts (.txt or .docx).
- **Checks** the export's files against its manifest, then the log as above: chains, commitments (with the words), replay, origins across devices, receipts against its own roots (never against certificates from the log), stamp entries, coverage and the clock check.
- **Bitcoin:** OpenTimestamps proofs that reach a block are shown with the block's height and the merkle root it must hold, as block explorers show it (byte-reversed), so anyone can look them up by hand. Check against Bitcoin fetches each block's header from mempool.space, then blockstream.info, only when pressed; the page's Content-Security-Policy allows no other connection.
- **Matches** each manuscript as under Exports. With the words (a full export), a manuscript that doesn't match is compared line by line with the manuscript the log replays to, and the first line that differs is shown.
- **Reports:** the same page as File → Scribe's Log → Verification Report…, with the same three privacy settings, which can be saved.
- **Plays a chapter back** (an export with the text, or any log with its words): Watch a chapter being written replays one chapter entry by entry, every device's chain merged by time, each step shown as the device that made it had the chapter then. Text that only arrived from another device isn't a step of its own (that device's entry is). What a step put in is marked, what it took out is shown going, and every stretch can be colored by its origin as the checker traces it (typed, pasted, moved within the book, imported, other). A log without its words has nothing to play, and the page says so. NEO's History window plays the same way (`slog-playback.js`).

Results say which parts checked, which couldn't be checked and why (an authority the page doesn't carry, a block not looked up, the writing after the last receipt), and which failed. A verifier can only vouch for itself as far as its source: the copy inside an export came with the export, so a checker who needs certainty uses a copy built from NEO's source (`node scripts/build-verifier.js`).

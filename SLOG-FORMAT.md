# Scribe's Log format, version 1 (draft)

The Scribe's Log is a tamper-evident record of how a book was written in NEO. This document defines the files well enough for anyone to write their own checker. NEO's own implementation is `slog.js`.

Draft status: the parts below are implemented and tested. Timestamp receipts (`stamp` entries), exports and signatures are reserved and will be specified when they're built.

## What it can and can't show

A log can show that it hasn't been altered since each outside timestamp, that the writing happened over the dates shown, which text was typed in NEO, moved within the book, pasted from outside, or imported, and that it ends in exactly a given manuscript.

It can't show that a human pressed the keys, that the ideas weren't a machine's, or anything about writing done outside NEO. It's process evidence, not proof of authorship.

## Files

Each book folder holds a `scribes-log/` folder:

- `log.json`: `{ "v": 1, "logId": "<16 hex>", "key": "<32 bytes, base64>" }`, written once. The key salts text commitments. It's never included in a log shared without its text.
- Chunk files, `YYYYMMDDTHHMMSSZ-<8 hex>.slog`: one session on one device. The time is the session's start in UTC; the hex is the first 8 characters of the device id. A name already taken gets `-2`, `-3`, and so on before `.slog`. Names sort by time, but chain order is decided by links (below), never by names.

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
| `open` | Starts a chunk | `v` (format, `1`), `log` (log id), `dev` (device id, 32 hex), `prevChunk` (name of this device's previous chunk, or `null`), `app` (NEO version, then `+slog1`) |
| `edit` | One burst of changes to one document | `doc`, `src`, `ops`, `c` if text was inserted, and optionally `dur`, `ev`, `cause`, `from`, `keys` |
| `base` | A document's whole text, with no process record behind it | `doc`, `src` (`baseline`, `import` or `arrived`), `ops` (a single `[0, 0, length]`), `c`, optionally `file` |
| `doc` | A document created or deleted | `doc`, `act` (`new` or `del`). A deleted document's text is first deleted by an `edit`, so a later move can point at it |
| `on`, `off` | The log switched on or off for this book. `off` is followed by the chunk's `close`; after `on`, whatever changed while the log was off is recorded with `cause: "off"` | |
| `sleep`, `wake` | The computer went to sleep or woke | |
| `clock` | The wall clock jumped against the computer's steady clock | `jump` (ms, negative for backward) |
| `close` | Ends a chunk | `why` (`close`, `quit`, `idle`, `off`, `size`, `error`), `ms` (manuscript hash) |
| `stamp` | Reserved: an outside timestamp receipt | |

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
| `move` | From elsewhere in NEO; `from` says where |
| `import` | Read in from a file. On a `base`, `file` gives that file's `mtime` (ms) and `sha256` (hex of its bytes); never its name |
| `arrived` | Written on another device and found on disk |
| `baseline` | In the book before the log began |
| `unlogged` | Reached disk without a labeled entry; origin unknown |

An edit that only deletes uses `src` for how the change was made: `typed` for the writer's own editing (the leaving half of a move included; `cause` says which tool), `arrived` for a change found on disk, `unlogged` when NEO can't say.

`cause` optionally names what in NEO made the change (`undo`, `redo`, `replace`, `outline`, `split`, `join`, `spell`, `darling`, `placeholder`, `off`).

`from`, for `move`, says where the text was when the log knows (a `move` without it is text from elsewhere in the same NEO, place not recorded). It's one of:

- `{ "n": <entry>, "op": <index>, "off": <offset> }`: text deleted by op `op` of entry `n` in this chain, starting `off` units into what it deleted. The moved text keeps the origin it had there.
- `{ "doc": <document>, "at": <offset> }`: copied from text still in that document, at that offset when this entry was made.
- `{ "log": <log id> }`: from another NEO book.

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

## Checking a log

For each device:

1. Read every chunk whose `open` names that device. Ignore a final line without `\n`, and a chunk with no complete line at all.
2. Order the chunks by links: the first has `prevChunk: null`; each next one names the one before. Two chunks naming the same predecessor is a fork; a chunk no chain reaches is unlinked. Both are damage.
3. Walk the entries in order. `n` must rise by exactly 1, and each `prev` must equal the hash of the entry before it.
4. With the key and words present, each `c` must match, each inserted string must have its recorded length, and each `markup` list must match the tags in its string.
5. Replay the ops from empty documents. Every op must fit the text it applies to. With words, this rebuilds every document exactly; without them, it still checks every length.

The replayed documents of a device are the book as that device last saw it. A `close` entry's `ms` can be compared with a manuscript's hash.

# FAQ

Plain answers about the Scribe's Log, versions and the Word round-trip. For step-by-step recipes, see the [How-To Guide](HOW-TO.md).

## The Scribe's Log

### What is the Scribe's Log?

A record of how your book was written, kept by NEO as you write. It notes each change in short bursts (a second or two at a time, not every key), which chapter it was in, and where the text came from: typed in NEO, pasted from outside, moved within the book, imported, or accepted from an editor. Each entry is chained to the one before it, so changing or removing an old entry breaks everything after it, and the chain is timestamped by two outside services as you go.

It's on for every book unless you turn it off.

### Can it prove I didn't use AI?

No, and nothing honest can. Here's what it can and can't show.

It **can** show that the log hasn't been altered since each outside timestamp, that the writing happened over the dates shown (not made up afterwards), which text was typed in NEO, moved within the book, pasted from outside or imported, and that it ends in exactly a given manuscript.

It **can't** show that a person pressed the keys, that the ideas weren't a machine's, or anything about writing done outside NEO. Someone who retypes AI text by hand gets a real log of typing. It's a record of the writing process, not proof of authorship.

What it does well is make a fake expensive: because of the timestamps, faking a log means sitting there typing the whole book in real time, over the whole period it claims, revisions and all.

### Does the log say anything about my computer?

No. Computers are only numbered, in the order they first wrote to the book ("Device 1"); nothing about the machines themselves is recorded. The report shows the book's title, the author name on it and its chapter titles, and none of the writing.

### Who can see my log?

Anyone who can open your book's folder: it lives in the book's `scribes-log` folder, next to the chapters, and syncs and backs up with them. Nobody else sees anything unless you send them a report or an export.

### Does anything leave my computer?

Only fingerprints. Every 15 minutes while you write, and when a session ends, NEO sends a short hash of the log (a fingerprint that can't be turned back into words) to FreeTSA and to the OpenTimestamps servers, which anchor it in Bitcoin. None of your words, titles or names are sent.

### Do I need the internet?

No. Without a connection NEO keeps writing the log and saves the timestamps it owes; they go out when you're back online. The writing in between is dated by your computer's clock until the next outside timestamp covers it, and the report says so.

### What does a publisher, agent or contest get?

Whatever you choose to send:

- **The Verification Report** (**File → Scribe's Log → Verification Report…**): a page (and PDF, if you like) summing up where the text came from, how it was revised, when you wrote and the outside timestamps. No writing in it. You pick exact times, dates only or weeks only.
- **An export** (**File → Scribe's Log → Export for Verification…**): the log itself, so they can check it. **Without the text** carries no words at all; **With the text** carries every word, deleted passages too. Either one comes with its own verifier page, which runs in any browser, offline, without NEO.

### What's in an export made "With the text"?

Everything: every word you wrote in NEO, every passage you later deleted, every chapter title and every author name the book has had. Send it only to someone you'd trust with your drafts. **Without the text** is enough for almost every check, including matching a manuscript to the log.

### What happens on two computers?

Each computer keeps its own chain, so two computers writing between syncs never clash. When text written on one shows up on the other, NEO logs it as arrived and traces it back to the computer that wrote it, so typed stays typed and pasted stays pasted. The verifier checks every chain and follows text across them.

### What if I write on my phone with NEO Pocket?

Pocket doesn't keep a log yet. Words written there reach the desktop as text that arrived from somewhere else, and the report counts them that way ("Arrived from another device, not traced"), not as typed.

### What if the log is off?

Nothing is recorded while it's off. What it recorded before stays in the book's folder. Turn it back on (**File → Scribe's Log → Log This Book**) and it picks up from there; the report shows what changed while it was off as its own line. Chapter History still works with the log off: NEO keeps a copy of each chapter you changed at the end of every session.

### I pasted from my old draft. Will that look bad?

It shows as "Pasted from outside", and stays a paste even after you revise it (the report says "then revised"; what you typed into it counts as typed). Importing a draft with **File → Import Manuscripts…** shows as "Imported". The report doesn't score or judge any of this; it only says where the words came from.

### Does the log slow NEO down or fill my disk?

It's built not to: it writes in the background, alongside NEO's own saves. It grows with your writing, one small file per session. **File → Scribe's Log → Merge Log into Archive** packs the closed sessions into one file whenever you like.

### Can I see my own log?

Yes. **File → Scribe's Log → Verification Report…** sums it up for you, and **View → Chapter History…** has **Play**, which shows a chapter being written change by change.

## Versions

### What's a version?

The book as it was at some moment. NEO rebuilds one for every writing session from the Scribe's Log, so you get them without doing anything. You can also name one (**File → Name This Version…**), and NEO names one by itself before anything big: restoring a chapter, Replace All, accepting an editor's changes in bulk, and sending a file to an editor.

### Where are versions kept?

Named versions live in the book's `versions` folder, a few small files, along with the chapter copies NEO keeps while the log is off. The rest are rebuilt from the log when you open **View → Chapter History…** Versions are never part of a log export or a report.

### Can I undo a restore?

Yes. Ctrl+Z (⌘Z) undoes it right away, and NEO names a version of the book before every whole-chapter restore, so you can go back even after a restart.

### I deleted a chapter. Is it gone?

No. Open **View → Chapter History…**, pick it from the chapter list (deleted chapters come after the book's own), and click **Restore as New Chapter**. It goes back in its old place with its history.

## Editors and Word

### What do my editor's words show as?

As "From an editor". When you accept a change, the words it brings in are logged as the editor's, never as typed by you, so the record stays honest both ways. If you turn down every wording and write your own, that's typed by you.

### Is my editor's name in the log?

No. The log calls them "Reviewer 1", "Reviewer 2", in the order you first imported their files. Their names stay in the book's `review.json`, which no export reads. When you make a Verification Report you can tick **Name the editors** to show the names in that one report.

### Does my editor need NEO?

No. They get an ordinary Word file (.docx) with Track Changes already on, and they work in Word as they always do. LibreOffice works too.

### What if my editor forgot to turn on Track Changes?

NEO compares their file with the version you sent and finds the changes anyway. They show in the Review tab marked "untracked".

### What if I kept writing after I sent the book?

That's fine. NEO knows which version the editor started from and places each change against today's text. A change to a passage you've since rewritten is marked "out of date", with the editor's wording beside yours, so you can apply it by hand.

### What if the file didn't come from NEO?

**File → Import Review…** still reads it. NEO asks which version it was made from, and suggests the closest.

### Will my editor see my replies?

Yes, on the next **File → Export → Word for an Editor…** Your replies go into the file as real Word replies, signed with the book's author name, and threads you resolved are marked done. Threads you resolved and deleted stay home.

### Does any of this show on my writing page?

No. Tracked changes and comments only ever show in the Review tab. The writing page stays clean.

## Other questions

### How do I find a command I can't remember?

Press Ctrl+K (⌘K) and type part of its name. Every menu command is there, with its shortcut.

### Do these features work in NEO Pocket?

Not yet. The Scribe's Log, Chapter History, the command palette, Manuscript Format and the Word round-trip are desktop only for now. Find and Replace works on both.

### Are these guides in my language?

Not yet: they're in English for now. NEO's menus and buttons are translated as before.

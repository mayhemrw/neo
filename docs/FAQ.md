# FAQ

Straight answers about the Scribe's Log, versions, and working with an editor in Word. Want step-by-step instructions instead? The [How-To Guide](HOW-TO.md) has them.

## The Scribe's Log

### What is the Scribe's Log?

The Scribe's Log (the Slog, for short) is a record of how your book got written, kept by NEO while you write. It notes each change in short bursts (a second or two at a time, not every keystroke), which chapter it was in, and where the words came from: typed in NEO, pasted from outside, moved within the book, imported, or accepted from an editor. Each entry is chained to the one before it, so changing or removing an old entry breaks everything after it. And the chain gets timestamped by two outside services as you go.

It's on for every book unless you turn it off. You don't have to think about it.

### Can it prove I didn't use AI?

No, and nothing honest can. Here's what it can and can't show.

It **can** show that the log hasn't been altered since each outside timestamp, that the writing happened over the dates shown (not cooked up afterwards), which text was typed in NEO, moved within the book, pasted from outside, or imported, and that it ends in exactly a given manuscript.

It **can't** show that a person pressed the keys, that the ideas weren't a machine's, or anything about writing done outside NEO. Someone who retypes AI text by hand gets a real log of typing. It's a record of the writing process, not proof of authorship.

What it does well is make faking expensive. Thanks to the timestamps, a fake log means sitting there typing the whole book in real time, over the whole period it claims, revisions and all. At that point, you may as well write the thing.

### Does the log say anything about my computer?

Next to nothing. Computers are only numbered, in the order they first wrote to the book ("Device 1"). Nothing about the machines themselves is recorded beyond which version of NEO wrote the log. The report shows the book's title, the author name on it, its chapter titles, the NEO version, and the time zone its times are shown in. None of the writing.

### Who can see my log?

Anyone who can open your book's folder. It lives in the book's `scribes-log` folder, right next to the chapters, and syncs and backs up with them. Nobody else sees a thing unless you send them a report or an export.

### Does anything leave my computer?

Only fingerprints. Every 15 minutes while you write, and when a session ends, NEO sends a short hash of the log (a fingerprint that can't be turned back into words) to FreeTSA and to the OpenTimestamps servers, which anchor it in Bitcoin. None of your words, titles, or names are sent. Ever.

### Do I need the internet?

No. Offline, NEO keeps writing the log and saves up the timestamps it owes; they go out when you're back online. The writing in between is dated by your computer's clock until the next outside timestamp covers it, and the report says so.

### What does a publisher, agent, or contest get?

Whatever you choose to send:

- **The Verification Report** (**File → Scribe's Log → Verification Report…**): a page (and a PDF, if you like) summing up where the words came from, how much you revised, when you wrote, and the outside timestamps. No writing in it. You pick exact times, dates only, or weeks only, and whether to name your editors.
- **An export** (**File → Scribe's Log → Export for Verification…**): the log itself, so they can check it, always with exact times. **Without the text** carries no words at all; **With the text** carries every word, cut passages too. Either one comes with its own verifier page, which runs in any browser, offline, without NEO.

### What's in an export made "With the text"?

Everything: every word you wrote in NEO, every passage you later cut, every chapter title, and every author name the book has ever had. Send it only to someone you'd trust with your messiest drafts. **Without the text** is enough for almost every check, including matching a manuscript to the log.

### What happens when I write on more than one computer?

Each computer keeps its own chain, so two computers writing between syncs never clash. When words written on one show up on the other, NEO logs them as arrived and traces them back to the computer that wrote them, so typed stays typed and pasted stays pasted. The verifier checks every chain and follows the words across them.

### What if I write on my phone with NEO Pocket?

Pocket doesn't keep a log yet. Words written there reach the desktop as text that arrived from somewhere else, and the report counts them that way ("Arrived from another device, not traced"), not as typed.

### What if the log is off?

Nothing gets recorded while it's off. What it recorded before stays in the book's folder. Turn it back on (**File → Scribe's Log → Log This Book**) and it picks up from there; the report shows what changed while it was off as its own line. Chapter History still works with the log off: NEO keeps a copy of each chapter you changed at the end of every session.

If you make a report or an export while the Slog is off, NEO asks first. **Switch On and Export** (or **Switch On and Make the Report**) turns it back on, so words that changed while it was off can be matched to your earlier writing, then offers to switch it off again right after. **Export As Is** leaves it off.

### I moved a paragraph. Does it still count as typed?

Yes. Words keep where they were first written, wherever they end up: cut and pasted, dragged, sent to Darlings and back, copied out of your Notes. Typed stays typed and pasted stays pasted. The report adds a line saying how much was moved at some point, but it's counted under where it came from.

### What's "Moved, origin unknown"?

Words NEO saw come off its own clipboard, or one of its own tools, but whose first appearance in the book it couldn't trace. It should be rare: before every report and export, NEO looks again through everything ever deleted from the book, and the book as it stood, and places what it can. Words copied from another book are only followed while that book has been open in the same run of NEO; otherwise they count as pasted.

### I sent a chapter to my editor and pasted their version back. What happens?

The paste is logged as a paste. Then, before a report or an export, NEO matches it against your earlier writing in the book, piece by piece: the stretches your editor didn't touch go back to your earlier writing's origin (typed, if you typed them), and the words they changed stay pasted (NEO can't tell who changed them). Curly versus straight quotes, dashes, and two spaces after a full stop don't count as changes, so an editor who only cleaned up the typography costs you nothing. A stretch has to match exactly for at least 20 characters to count, so heavy line edits mostly stay pasted.

The better route is **File → Export → Word for an Editor…** and **File → Import Review…**: your editor's changes come in marked as theirs ("From an editor"), and everything else stays yours, no matching needed.

### Can matching make pasted text look typed when it wasn't?

Not NEO's matching. It only ever matches against writing that was already in this book's log before the paste, and the words take the origin of that writing, whatever it was. Text pasted from ChatGPT matches nothing you typed, so it stays pasted. Words that match an earlier paste stay pasted. And when the same words were written more than once, the earliest wins. Anything already recorded as typed, imported, or an editor's is never changed.

The matches go into the log itself. In an export with the text, the verifier checks every one word for word, and a match that doesn't hold is flagged as damage. Without the text it can only check their lengths, and the report says so.

### I pasted from my old draft. Will that look bad?

If that draft was written in this book in NEO (say you copied a chapter out to Word and pasted it back), NEO matches it to your earlier writing before a report or an export, and the stretches that still match (20 characters or more, typography aside) count as typed. A draft from elsewhere shows as "Pasted from outside", and stays a paste even after you revise it (the report says "then revised"; anything you typed into it counts as typed). A draft brought in with **File → Import Manuscripts…** (which makes it a new book) shows as "Imported". The report doesn't score or judge any of this. It only says where the words came from.

### Does the log slow NEO down or fill my disk?

It's built not to. It writes in the background, alongside NEO's own saves, and grows with your writing, one small file per session. **File → Scribe's Log → Merge Log into Archive** packs the closed sessions into one file whenever you like.

### Can I see my own log?

Sure. **File → Scribe's Log → Verification Report…** sums it up, and **View → Chapter History…** has **Play**, which shows a chapter being written, change by change. It's oddly satisfying.

## Versions

### What's a version?

The book as it was at some moment. NEO rebuilds one for every writing session from the Scribe's Log, so you get them without lifting a finger. You can also name one (**File → Name This Version…**), and NEO names one by itself before anything big: restoring a chapter, Replace All, accepting a batch of an editor's changes, and sending a file to an editor.

### Where are versions kept?

Named versions live in the book's `versions` folder, a few small files, along with the chapter copies NEO keeps while the log is off. The rest are rebuilt from the log when you open **View → Chapter History…** Versions are never part of a log export or a report.

### Can I undo a restore?

Yes. Ctrl+Z or ⌘Z undoes it right away, and NEO saves a version of the book before every whole-chapter restore, so you can go back even after a restart.

### I deleted a chapter. Is it gone?

Nope. Open **View → Chapter History…**, pick it from the chapter list (deleted chapters come after the book's own), and click **Restore as New Chapter**. It goes back where it was (or at the end, if the chapter it followed is gone too), history and all.

## Editors and Word

### What do my editor's words show as?

As "From an editor", but only the words the editor actually wrote. When you accept a change, the new words it brings in are logged as the editor's, never as typed by you, so the record stays honest both ways.

Words an editor only moved stay yours. Accepting a move logs it as a move, and moved words keep where they were first written, so a paragraph you typed is still yours wherever the editor puts it. Words the editor cut are simply deleted. And if you turn down every wording and write your own, that's typed by you.

### Is my editor's name in the log?

No. The log calls them "Reviewer 1", "Reviewer 2", in the order you first imported their files. Their names stay in the book's `review.json`, which no export reads. When you make a Verification Report you can tick **Name the editors** to show the names in that one report.

### Does my editor need NEO?

No. They get an ordinary Word file (.docx) with Track Changes already on, and they work in Word the way they always do. LibreOffice works too.

### What if my editor forgot to turn on Track Changes?

NEO compares their file with the version you sent and finds the changes anyway. They show in the Review tab marked "made without Track Changes".

### What if I kept writing after I sent the book?

That's fine. NEO knows which version the editor started from and places each change against today's text. A change to a passage you've since rewritten is marked "out of date", with the editor's wording beside yours, so you can apply it by hand.

### What if the file didn't come from NEO?

**File → Import Review…** still reads it. NEO asks which version it was made from, and suggests the closest.

### What if I import the file into the wrong book?

NEO notices. The file it sends to an editor says which book it came from, inside the file, so renaming it doesn't matter. Import it into another book and NEO tells you where it belongs and offers to open that book and import it there, or to import it here anyway (say, into a copy you made of the book since). If the file has lost that mark (some programs, like Google Docs or Pages, drop it when they save a Word file), NEO asks which version it was sent from and compares the file with the book: if it hardly shares a passage with it, NEO checks with you before importing. Either way, nothing in a book changes until you accept a change.

### Does NEO keep a copy of my editor's file?

No. You've got the file already, wherever your editor sent it. NEO keeps what it read from it (the changes, the comments, and what you decided) in the book's `review.json`.

### Can I fix a reply before my editor sees it?

Yes. Hover over your reply in the Review tab's margin and click **Edit**, any time before it goes out with **File → Export → Word for an Editor…** After that, it's in your editor's hands.

### Will my editor see my replies?

Yes, on the next **File → Export → Word for an Editor…** Your replies go into the file as real Word replies, signed with the book's author name (or "Author" if it has none), and threads you resolved are marked done. Threads you resolved and deleted stay home.

### If I duplicate a book, does the copy get the editor's changes?

If any are still waiting, NEO asks. Copy them, and the new book opens with the same changes and comments to go through (handy if you like a safety copy before diving in). Leave them, and the copy starts with a clean slate.

### Does any of this show on my writing page?

No. Tracked changes and comments only ever show in the Review tab. The writing page stays a clean page.

## Other questions

### How do I find a command I can't remember?

Press Ctrl+K or ⌘K and type part of its name. Every menu command is there, with its shortcut.

### Do these features work in NEO Pocket?

Not yet. The Scribe's Log, Chapter History, the command palette, Manuscript Format, and the Word round-trip are desktop only for now. Find and Replace works on both.

### Are these guides in my language?

Not yet. They're in English for now, though NEO's menus and buttons are translated as before.

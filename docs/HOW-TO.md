# How-To Guide

This is the quick-and-dirty guide to the newer stuff in NEO: the Scribe's Log, versions, Find and Replace, the command palette, manuscript format, and sending your book to an editor and getting it back. Each recipe is a few steps with the exact menu names, so you can stop reading and get back to writing. Shortcuts are written for Windows and Linux, with the Mac's after them: Ctrl+K or ⌘K.

Got a "but what about…" question? The [FAQ](FAQ.md) has plain answers.

## Prove you wrote your book

Good news: you already are. The Scribe's Log is on for every book from the first word. It quietly keeps a record of how your book got written, session by session, and has that record timestamped by two outside services as you go. You don't click anything. You just write.

When someone asks how the book was written:

1. Open the book.
2. Choose **File → Scribe's Log → Verification Report…**
3. Pick how exactly to show the times: **Exact times**, **Dates only**, or **Weeks only**. Dates only is the usual pick: it shows which days you wrote, not that you were up at 3 AM.
4. Tick **Also save it as a PDF** if the person would rather have a PDF. If an editor's changes are in the book, **Name the editors** puts their names in this one report (the log itself only ever says Reviewer 1, Reviewer 2).
5. Click **Save Report…** and pick a place. NEO closes the writing session, matches any words whose origin wasn't recorded (your own words pasted back from Word, say) to your earlier writing, timestamps the end, and saves the report.

If the Slog is off for the book, NEO asks first: **Switch On and Make the Report** turns it back on so it can trace what changed meanwhile (you can switch it off again right after), or **Make the Report As Is**.

The report is a summary anyone can read: where the words came from (typed in NEO, pasted, imported, or from an editor), how much you revised, when you wrote, and the outside timestamps. It shows the title, your author name, and the chapter titles. None of the writing itself.

Want them to be able to check it for themselves? Send them an export too. That's the next recipe.

## Send someone your log so they can check it

1. Open the book.
2. Choose **File → Scribe's Log → Export for Verification…**
3. Pick one:
   - **Without the text**: how the book was written, but none of its words. Every check still works except a word-for-word comparison, and a manuscript can still be matched against the log's fingerprint. This is the one to send almost every time.
   - **With the text**: every word of the book as you wrote it, including every passage you cut. Send this only to someone you'd trust with your messiest drafts.
4. Save the .zip and send it, along with the manuscript (.txt or .docx) if they don't already have it.

Before it writes the .zip, NEO matches any words whose origin wasn't recorded to your earlier writing, the same as for a report, and puts those matches in the log, so whoever checks it sees them. An export without the text can't show the words behind a match, so its report lists matched text on its own line ("Matched to earlier writing (not checkable without the text)") rather than as typed. With the Slog off, it asks first, as the report does.

The .zip carries its own copy of the verifier, so nobody needs NEO to check it. An export always carries exact times, whatever you picked for a report: it's the record itself, warts and all.

## Check a log someone sent you

1. Unzip the export and open **verifier.html** in any web browser. It works offline.
2. Drop the .zip itself on the page (or use **Choose files…**).
3. Read the result. "Everything here checks." means nothing in the record was changed, added, or taken out since it was written, and the timestamps match.
4. To match a manuscript to the log, click **Check a manuscript…** and pick the .txt or .docx. The verifier tells you whether it's exactly the text the log ends in.
5. **Check against Bitcoin** looks up the OpenTimestamps proofs in Bitcoin's blocks. It's the only thing the page ever uses the internet for.

## Watch a chapter being written

This one's fun. NEO can play back a chapter the way you wrote it, every word going in and coming out.

1. Open the book and choose **View → Chapter History…** (Ctrl+Shift+H or ⌘⇧H).
2. Pick the chapter at the top and a version on the left. Playback runs from that version to now; the newest version plays the whole chapter from its first word.
3. Click **Play**. Space plays and pauses; the arrow keys step (Shift+arrow jumps ten steps). Long pauses are skipped, so you don't have to watch yourself go make coffee.

The verifier can do it too. An export made **With the text** has **Watch a chapter being written**: pick a chapter and click **Watch**.

## Go back to an earlier version of a chapter

Deleted the wrong scene? Liked it better on Tuesday? NEO kept it.

1. Open the book and go to the chapter.
2. Choose **View → Chapter History…** (Ctrl+Shift+H or ⌘⇧H).
3. The chapter's versions are on the left, newest first: one for every writing session, plus any you named. Click one.
4. **Read** shows it as it was. **Compare** shows what's changed since (or against another version, under **Compare with**): struck-through words are gone now, underlined ones are new.
5. To get it back:
   - The whole chapter: **Restore This Version**. NEO first saves a version of the book as it stands, so nothing is lost, and Ctrl+Z or ⌘Z undoes the restore.
   - Just a passage: select it, click **Copy**, close the window, and paste it where you want it.
   - A chapter you deleted: pick it in the chapter list at the top (deleted chapters come after the book's own), then **Restore as New Chapter**. It goes back where it was (or at the end, if the chapter it followed is gone too).

Restored words keep their history: words you typed come back as typed, and a paste comes back as a paste.

## Name a version before a big change

About to send a draft out, or take a chainsaw to the middle of the book? Give yourself a bookmark first.

1. Choose **File → Name This Version…**
2. Give it a name, like "Sent to Maria" or "Before the big cut".

Named versions show in **View → Chapter History…** beside every chapter they hold, where you can rename or delete them. A named version can even put every chapter's title back at once: **Restore All Chapter Titles**.

## Replace a word across the whole book

Changed a character's name? Decided "grey" is "gray" after all?

1. Choose **Edit → Find & Replace** (Ctrl+F or ⌘F).
2. Type what to find. Turn on the options you need:
   - **Match case** (Aa): "Grey" but not "grey".
   - **Whole word** (ab): "cat" but not "category".
   - **Include chapter titles** (§): search the titles too.
3. Click **List** to see every hit in context, grouped by chapter. Enter jumps to a hit; **Dock** moves the list into the right-hand pane.
4. Type the new word in **Replace with**.
5. **Replace** changes the hit you're on. **All** changes every one, after saving a version of the book ("Before replacing 'colour'"), so you can always get the old text back from Chapter History. Ctrl+Z or ⌘Z undoes it too.

A hit that runs across formatting (half in italics, say) is never changed blind. NEO lists those under "Mixed formatting" and asks you: **Keep formatting** or **Plain**.

## Export in manuscript format

Agents and editors want what they want: double-spaced 12 point, one-inch margins, a title page with your contact details, and your surname, the title, and the page number at the top of every page. NEO does all of that for you.

1. Open the book.
2. Choose **File → Export → Manuscript Format…**
3. Fill in your details for the title page: name, address, phone, and email. NEO remembers them for every book.
4. Check the byline and the header (surname and title), and pick Times New Roman or Courier.
5. Click **Save as Word (.docx)** or **Save as PDF**.

The word count on the title page is rounded the way agents expect ("about 90,000 words"). The copyright, dedication, contents, acknowledgments, and about-the-author pages stay out, because nobody reading a submission wants them.

## Send your book to an editor and bring it back

Your editor works in Word. You work in NEO. This is how the two meet.

**Sending:**

1. Open the book and choose **File → Export → Word for an Editor…**
2. Type the editor's name (NEO offers names you've used before) and save the file.
3. Send the .docx to your editor. It opens in Word with Track Changes already on, so they can't forget.

NEO saves a version of the book at that moment ("Sent to Dana (Oct 9)"), so it always knows what the editor started from, even if you keep writing in the meantime. (Scripts have their own formats and can't be sent this way.)

**Bringing it back:**

1. When the file comes back, open the book and choose **File → Import Review…** (or drop the .docx on the open book's page).
2. NEO tells you what it found ("Dana: 212 changes, 31 comments") and opens the **Review** tab. Nothing in your book has changed yet. Breathe.
3. Go through the changes: **Accept** (A) or **Reject** (R) each one; J and K step through them. Or accept or reject a whole chapter, a whole reviewer, or **Accept All**. Every accept is one Ctrl+Z or ⌘Z step, and accepting a batch at once saves a version first.
4. Comments sit in the margin beside their words. Type a reply and press Ctrl+Enter. Changed your mind about a reply? Hover over it and click **Edit**, any time before it goes back to the editor. **Resolve** marks a thread done and keeps it; **Resolve and Delete** tucks it under "Deleted comments" at the foot of the margin, where **Put back** brings it back.
5. Next time you choose **File → Export → Word for an Editor…**, your replies and resolved threads go to the editor as real Word comments.

The Review tab only shows up while something's waiting, and **View → Review** (Ctrl+Alt+R or ⌘⌥R) gets you there. Your writing page never shows any of this markup. It stays a clean page.

If the editor forgot to turn on Track Changes (it happens), NEO still finds what they changed by comparing the file with the version it was sent from, and marks those changes "made without Track Changes".

Making a copy of the book before you dive in? **Duplicate** asks whether the copy should take the editor's changes and comments too.

## Work with two editors at once

1. Send each editor their own file with **File → Export → Word for an Editor…**
2. Import each file when it comes back with **File → Import Review…**
3. In the Review tab, each editor has a chip in their own color. Click a name to hide or show their changes; Alt-click shows only theirs (**Show everyone** brings everyone back, and Accept All becomes **Accept Shown**). Click the dot to pick another color.
4. Where both changed the same words, the list shows "One passage, two wordings" side by side. Pick one (its **Use …'s** button, or 1 or 2), **Write your own** (W; Ctrl+Enter puts your wording in, Esc backs out), or **Reject all** (R).

A file passed from one editor to the next keeps each person's changes under their own name, and you can take them in any order.

## Run any command from the keyboard

Hands on the keyboard, eyes on the page.

1. Press Ctrl+K or ⌘K, or choose **View → Command Palette…**
2. Type a few letters of what you want: "hist" finds Chapter History…, and "man for" finds Manuscript Format…
3. Press Enter. The up and down arrows pick another line; Esc closes it.

The last five commands you used come first. To trim the list, hover over the box and click the pencil, then untick what you never use. Typing still finds a hidden command.

## Write on more than one computer

1. On each computer, choose **File → Library Folder…** and pick the same synced folder (Google Drive, iCloud Drive, Dropbox, or Syncthing).
2. Write on either one. Each computer keeps its own chain in the log, so they never trip over each other.

The report and the verifier number the computers (Device 1, Device 2) and say nothing else about them. Text written on one computer and opened on the other keeps its history: typed is still typed, and pasted is still pasted. Versions you name on one computer show up in Chapter History on the other.

If both computers changed the same chapter before syncing, NEO keeps your words on the page and adds the other computer's text as the next chapter. Nothing gets lost.

## Turn the log off for a book

1. Open the book.
2. Choose **File → Scribe's Log → Log This Book** to untick it.

What the log already recorded stays in the book's folder. Tick it again to start logging where you left off; the report counts whatever changed in between under "Changed while the log was off", except words NEO can match to your earlier writing (the report says how many of those there were). Making a report or an export with the log off asks whether to switch it on first. With the log off, NEO still keeps a copy of each chapter you changed at the end of every session, so Chapter History keeps working.

## Tidy up the log's files

Each writing session adds a small file to the book's `scribes-log` folder. After a few hundred sessions you might want fewer of them (some sync services get sluggish with lots of little files).

1. Open the book.
2. Choose **File → Scribe's Log → Merge Log into Archive**.

Every closed session goes into one archive file. Nothing is lost, and everything still checks.

## Find these guides again

**Help → How-To Guide…** and **Help → FAQ…** open them inside NEO, offline. **View → Keyboard Shortcuts…** (Ctrl+/ or ⌘/) lists every shortcut.

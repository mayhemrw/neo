# How-To Guide

Short recipes for the things this version of NEO adds: the Scribe's Log, versions, Find and Replace, the command palette, manuscript format and sending a book to an editor. Each one is a few steps with the exact menu names. Shortcuts are written for Windows and Linux, with the Mac's in brackets.

For plain answers about what the Scribe's Log can and can't do, see the [FAQ](FAQ.md).

## Prove you wrote your book

The Scribe's Log is already on for every book. It keeps a private record of how the book was written, session by session, and has it timestamped by two outside services as you go. You don't have to do anything while you write.

When someone asks how the book was written:

1. Open the book.
2. Choose **File → Scribe's Log → Verification Report…**
3. Pick how exactly to show the times: **Exact times**, **Dates only** or **Weeks only**. Dates only is the usual choice: it shows which days you wrote, not when in the day.
4. Tick **Also save it as a PDF** if the person would rather have a PDF.
5. Click **Save Report…** and pick a place. NEO closes the writing session, timestamps its end and saves the report.

The report is a summary they can read: where the text came from (typed in NEO, pasted, imported, an editor's), how much it was revised, when you wrote, and the outside timestamps. It shows the title, your author name and the chapter titles, and none of the writing itself.

If they want to check the record for themselves, send them an export too (next recipe).

## Send someone your log so they can check it

1. Open the book.
2. Choose **File → Scribe's Log → Export for Verification…**
3. Pick one:
   - **Without the text**: how the book was written, but none of its words. Every check still works, and a manuscript can still be matched against the log's fingerprint. This is the one to send almost always.
   - **With the text**: every word of the book as you wrote it, including every passage you deleted. Send it only to someone you'd trust with your drafts.
4. Save the .zip and send it, along with the manuscript (.txt or .docx) if they don't already have it.

The .zip carries its own copy of the verifier, so nobody needs NEO to check it.

## Check a log someone sent you

1. Unzip the export and open **verifier.html** in any web browser. It works offline.
2. Drop the .zip itself on the page (or use **Choose files…**).
3. Read the result. "Everything here checks." means no part of the record was changed, added or taken out since it was written, and the timestamps match.
4. To match a manuscript to the log, click **Check a manuscript…** and pick the .txt or .docx. The verifier tells you whether it's exactly the text the log ends in.
5. **Check against Bitcoin** looks up the OpenTimestamps proofs in Bitcoin's blocks. It's the only thing the page ever uses the network for.

## Watch a chapter being written

In NEO:

1. Open the book and choose **View → Chapter History…** (Ctrl+Shift+H, ⌘⇧H).
2. Pick the chapter at the top and a version on the left. Playback runs from that version to now; the newest version plays the whole chapter from its first word.
3. Click **Play**. Space plays and pauses; the arrow keys step. Long pauses are skipped.

In the verifier, an export made **With the text** has **Watch a chapter being written**: pick a chapter and click **Watch**.

## Go back to an earlier version of a chapter

1. Open the book and go to the chapter.
2. Choose **View → Chapter History…** (Ctrl+Shift+H, ⌘⇧H).
3. The chapter's versions are on the left, newest first: one for every writing session, plus any you named. Click one.
4. **Read** shows it as it was. **Compare** shows what's changed since (or against another version, under **Compare with**): struck-through words are gone now, underlined ones are new.
5. To get it back:
   - The whole chapter: **Restore This Version**. NEO first names a version of the book as it stands, so nothing is lost, and Ctrl+Z (⌘Z) undoes the restore.
   - Just a passage: select it, click **Copy**, close the window and paste it where you want it.
   - A chapter you deleted: pick it in the chapter list at the top (deleted chapters come after the book's), then **Restore as New Chapter**. It comes back in its old place.

Restored words keep their history: words you typed come back as typed, a paste comes back as a paste.

## Name a version before a big change

Before you send a draft out, or tear up the middle of the book:

1. Choose **File → Name This Version…**
2. Give it a name, like "Sent to Maria" or "Before the big cut".

Named versions show in **View → Chapter History…** beside every chapter they hold, where you can rename or delete them. A named version can put every chapter's title back at once, too: **Restore All Chapter Titles**.

## Replace a word across the whole book

1. Choose **Edit → Find & Replace** (Ctrl+F, ⌘F).
2. Type what to find. Turn on the options you need:
   - **Match case** (Aa): "Grey" but not "grey".
   - **Whole word**: "cat" but not "category".
   - **Include chapter titles** (§): search the titles too.
3. Click **List** to see every hit in context, grouped by chapter. Enter goes to a hit; **Dock** moves the list into the right-hand pane.
4. Type the new word in **Replace with**.
5. **Replace** changes the hit you're on. **All** changes every one, after naming a version of the book ("Before replacing 'colour'"), so you can always get the old text back from Chapter History. Ctrl+Z (⌘Z) undoes it too.

A hit that runs across formatting (half in italics, say) is never changed blind. NEO lists those under "Mixed formatting" and asks: **Keep formatting** or **Plain**.

## Export in manuscript format

For agents and editors who want standard manuscript format: double-spaced 12 point, one-inch margins, a title page with your contact details, and your surname, the title and the page number at the top of each page.

1. Open the book.
2. Choose **File → Export → Manuscript Format…**
3. Fill in your details for the title page: name, address, phone, email. NEO remembers them for every book.
4. Check the byline and the header (surname and title), and pick Times New Roman or Courier.
5. Click **Save as Word (.docx)** or **Save as PDF**.

The word count on the title page is rounded the way agents expect ("about 90,000 words"). The copyright, dedication, contents, acknowledgments and about-the-author pages stay out.

## Send your book to an editor and bring it back

**Sending:**

1. Open the book and choose **File → Export → Word for an Editor…**
2. Type the editor's name (NEO offers names you've used before) and save the file.
3. Send the .docx to your editor. It opens in Word with Track Changes already on.

NEO names a version of the book at that moment ("Sent to Dana (Oct 9)"), so it always knows what the editor started from, even if you keep writing.

**Bringing it back:**

1. When the file comes back, open the book and choose **File → Import Review…** (or drop the .docx on the open book's page).
2. NEO says what it found ("Dana: 212 changes, 31 comments") and opens the **Review** tab. Nothing in your book has changed yet.
3. Go through the changes: **Accept** (A) or **Reject** (R) each one; J and K step through them. Or accept or reject a whole chapter, a whole reviewer, or **Accept All**. Every accept is one Ctrl+Z (⌘Z) step, and accepting many at once names a version first.
4. Comments sit in the margin beside their words. Type a reply and press Ctrl+Enter, or click **Resolve** (kept, marked done) or **Resolve and Delete** (kept under "Deleted comments" at the foot of the margin, where **Put back** brings it back).
5. Next time you choose **File → Export → Word for an Editor…**, your replies and resolved threads go to the editor as real Word comments.

The Review tab is there only while something waits, and **View → Review** (Ctrl+Alt+R, ⌘⌥R) gets you to it. Your writing page never shows any of this markup.

If the editor forgot to turn on Track Changes, NEO still finds what they changed by comparing the file with the version it was sent from, and marks those changes "untracked".

## Work with two editors at once

1. Send each editor their own file with **File → Export → Word for an Editor…**
2. Import each file when it comes back with **File → Import Review…**
3. In the Review tab, each editor has a chip with their color. Click a name to hide or show their changes; Alt-click shows only theirs. Click the dot to change their color.
4. Where both changed the same words, the list shows "One passage, two wordings" side by side. Pick one (1 or 2), **Write your own** (W), or **Reject all** (R).

A file passed from one editor to the next keeps each person's changes under their own name, and you can take them in any order.

## Run any command from the keyboard

1. Press Ctrl+K (⌘K), or choose **View → Command Palette…**
2. Type a few letters of what you want: "hist" finds Chapter History…, "man for" finds Manuscript Format….
3. Press Enter. Up and down arrows pick another line; Esc closes it.

The last five commands you used come first. To trim the list, hover over the box and click the pencil, then untick what you never use. Typing still finds a hidden command.

## Write on two computers

1. On each computer, choose **File → Library Folder…** and pick the same synced folder (Google Drive, iCloud Drive, Dropbox, Syncthing).
2. Write on either one. Each computer keeps its own chain in the log, so they never trip over each other.

Text written on one computer and opened on the other keeps its history: typed is still typed, pasted is still pasted. Versions you name on one computer show in Chapter History on the other.

If both computers changed the same chapter before syncing, NEO keeps your words on the page and adds the other computer's text as the next chapter, so nothing is lost.

## Turn the log off for a book

1. Open the book.
2. Choose **File → Scribe's Log → Log This Book** to untick it.

What the log already recorded stays in the book's folder. Tick it again to start logging where you left off; the report will show a gap marked "Changed while the log was off". With the log off, NEO still keeps a copy of each chapter you changed at the end of every session, so Chapter History keeps working.

## Tidy up the log's files

Each writing session adds a small file to the book's `scribes-log` folder. After a few hundred sessions you may want fewer files (some sync services slow down with many small ones).

1. Open the book.
2. Choose **File → Scribe's Log → Merge Log into Archive**.

Every closed session goes into one archive file. Nothing is lost and everything still checks.

## Find these guides again

**Help → How-To Guide…** and **Help → FAQ…** open them inside NEO, offline. **View → Keyboard Shortcuts…** (Ctrl+/, ⌘/) lists every shortcut.

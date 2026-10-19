Team 10 Reddit Archiver v3.0 - install / update
1. Unzip this folder over your old Reddit Archiver folder (keep your existing "icons" folder - it is not included here).
2. chrome://extensions -> enable Developer mode -> Load unpacked -> select the folder
   (or click the reload icon on the existing extension). Chrome will ask to approve the new
   "debugger" permission - this is used only for the one-page PDF of the original Reddit page.
3. Open a Reddit post, click the extension icon, enter your name, choose the export options,
   press "Start Capturing Post/Comments".
4. On the results tab:
   - Tick the comments of interest and give a reason.
   - Highlight text in the post title, post text or ANY comment and press "Add Information Entry With Quote"
     (the button also pops up right next to your highlight). Type the information, tick "Also flag this
     comment" if you want, and press Add. The quote, its source (who / when / link) and your information
     go into the Assessment. Highlighted text stays yellow - click it to jump to its entry; "Show in page" jumps back.
   - Plain information items can still be typed into the Information box, one per line.
   - Untick an image box to leave that image out of the DOCX / TXT / clipboard / working document.
   - Fill in Notes and Next Action(s), then Export - or use the Download / "DOCX to Clipboard" buttons.
Note: the PDF of the original page uses Chrome's debugger interface, so Chrome shows a
"started debugging this browser" bar for a few seconds while it is captured. If the post is not
open in the current tab when you start, it is opened in a temporary tab for the capture and closed again.

PDF options
- "PDF (original page)": one long page of the real Reddit page, with ads, promoted posts and log-in /
  app prompts removed. It shows the comments Reddit has loaded on the page.
- "PDF (full thread)": the post and EVERY captured comment as shown on the review page, with your flags,
  highlights and Assessment. Choose "Single long page" or "A4 pages" in the popup. In Chrome's print dialog
  pick "Save as PDF" and leave Margins on "Default". Very large threads are split into a few very long pages.

Working documents
- In the popup, enter your name, then use [New Doc] (document number + case initials) or [Load Doc].
  Documents are called "D### XX Media Search - Reddit" and are stored inside Chrome (browser storage for this
  extension), not as visible files. Clearing the extension's site data or removing the extension deletes them.
  They are separate from the News Article Extractor's working documents.
- On the results page, [Add to Working Document] stores the post, its flagged comments, ticked images,
  information entries and your Assessment. Adding the same post again offers to update it.
- "Show/Hide document content summary & Document Options" -> [Create Final DOCX] lets you group every
  information point by subject, pick the suggested actions, and builds the combined document.

Manage Docs (popup)
- [Manage Docs] lists every stored working document. Tick one or more, then:
  Delete (asks first) | Export (saves a .T10reddit file to your Downloads folder) | Import (reads a .T10reddit file).
- A .T10reddit file carries a checksum, so a damaged or hand-edited file is rejected on import. Files made by older or
  newer versions of the extension import fine: missing sections are filled in, unknown sections are ignored.
- Importing a document whose name already exists asks before replacing it.
- Import opens in its own small window, because Chrome closes a toolbar popup as soon as a file dialog opens.
  Click Import there again and choose the file; the imported document becomes the working document.

---

name: site-publisher
description: "Use when the owner wants a small web page or static site (a report, a menu, a shareable list) published on this PasaBot server."
---

# Publishing a small site

PasaBot can host small static sites for you on its separate sites address. They are plain files: HTML, CSS,
JavaScript, images. There is no server code and no database behind them.

## Steps

1. Agree on what the page is for and who will open it. Ask whether it should be reachable from outside the
   owner's network; by default it is not.
2. Build the files in your workspace first: an `index.html`, one stylesheet, and only the scripts you need. Keep
   it small; there is a limit on the number of files and the total size.
3. Check it: every link points at a file you are publishing, text is readable on a phone (390 px wide), there are
   no secrets, tokens or private data in any file.
4. Publish with the sites tool (its name starts with `sites_`) and give the owner the address it returns.
5. Sites expire. If the owner wants it kept, renew it before it runs out and say until when.

## Rules

- The page runs in a sandbox and cannot use the owner's sign-in. Do not try to call the PasaBot API from it.
- Never copy a page, logo or text from another product or website; make your own.
- Publishing is visible to others, so the owner may be asked before it goes out.

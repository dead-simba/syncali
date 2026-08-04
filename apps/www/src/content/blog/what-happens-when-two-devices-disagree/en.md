---
title: "What happens when two devices disagree"
description: "Which version wins when you edit the same note on two devices, why an empty note can silently eat your writing in other sync tools, and where conflict copies actually appear."
pubDate: 2026-08-04
---

Every question below came from someone setting Syncali up for real, usually
about ten minutes before trusting it with a year of notes. They are the right
questions to ask, so here are honest answers.

## I edited the same note on my laptop and my phone, both offline. Which one wins?

Usually neither, because usually both survive.

Say the note has three paragraphs. You edit the first on your laptop and the
third on your phone, with neither online. When they reconnect:

1. Whichever device syncs first is accepted normally.
2. The second is **rejected** — the server can see it was based on a version
   that has since moved on.
3. That device pulls the other's change and runs a **three-way merge**:
   the original, your version, and theirs.
4. Different paragraphs, so both edits land in one file. No conflict, nothing
   lost.

This is the common case, which is why most people never think about it.

## And if we both edited the same line?

Then a merge would have to guess, so it does not.

- The remote version keeps the real filename.
- Your local version is saved next to it as a conflict copy.
- You get a notice naming the exact file.

Nothing is destroyed. You open both, keep what you want, delete the other.

## Where do conflict copies appear?

Right beside the original, in the same folder:

```
My Life/Journal/1 - Daily/
    Aug 04, 2026.md                                ← remote version keeps this name
    Aug 04, 2026.sync-conflict-20260804-203300.md  ← your local version, preserved
```

The timestamp is when the conflict was noticed, not when you wrote it. It is an
ordinary Markdown file, so it appears in your file explorer and search like
anything else.

Two things surprise people:

**It only exists on the device that synced second.** The conflict copy is
written by whichever device was holding an unsent edit when the other's change
arrived. If that was your phone, the file is on your phone.

**Conflict copies never sync.** They are excluded deliberately — otherwise one
conflict would multiply across every device you own. So look on the device that
showed you the notice. It will not appear on the others.

## I lost notes once. I wrote on my phone offline, opened my laptop, and my writing was replaced by an empty note. Can that happen here?

Not the same way, and the reason is worth understanding because it is the single
biggest difference between sync tools.

General file-sync tools — Syncthing, Resilio, Dropbox, iCloud — resolve
disagreements by **modification time**. Newest file wins, whole file, no merge.

That rule is what ate your note. Obsidian's Daily Notes plugin **creates today's
note automatically** the moment you open the app. So your laptop generated an
empty daily note, that empty file had a newer timestamp than your phone's
writing, and it won. The tool did exactly what it was designed to do.

Syncali never compares timestamps. Every file carries a **revision number**, and
every upload declares which revision it was based on. If the server has moved
past that revision, the upload is rejected and merged rather than applied.

For that exact scenario, the merge has a rule that settles it: **if one side is
unchanged from the original, take the other side.** An auto-created empty note is
unchanged from nothing. Your writing is a real change. The writing wins — not by
winning a timestamp race, but because one side has content and the other does
not.

## Does every file type merge?

No. Only Markdown.

Images, PDFs, and canvas files cannot be meaningfully merged, so any clash there
goes straight to a conflict copy. Obsidian Sync works the same way.

## What can the server actually read?

Your file contents and your file paths are encrypted on your device before they
are uploaded. The server cannot read either, and neither can we if you use our
hosted service.

What the server does see: file sizes, timestamps, how much storage you use,
vault and device identifiers, and your IP address.

Encryption hides your notes. It does not hide the fact that you have them, or
how big they are. Anyone telling you otherwise is selling something.

## If I turn a plugin on here, does it turn on everywhere?

Only if you ask for it. There are separate switches, and the distinction matters:

- **Installed community plugins** syncs the plugin *files*, so a plugin
  installed on your laptop becomes available everywhere.
- **Active community plugin list** syncs which plugins are *enabled*.

Turn the first on and leave the second off, and you get plugins available
everywhere while each device decides for itself what to run. That is usually
what people actually want on a phone.

Both default to off.

## Can I make one device the source of truth for settings?

Not with a setting, and not on Obsidian Sync either — their docs are explicit
that "primary device" is a naming convention, not a feature.

There is a real tradeoff hiding here. Which plugins are enabled is a **single
file**. Either it syncs, and toggling a plugin on your laptop toggles it on your
phone, or it does not, and a freshly reinstalled device arrives with every
plugin present but switched off, waiting for you to choose.

You cannot have both. Pick which you would rather do once.

## Does the order I set things up in matter?

More than you would expect.

The **first** device you enable configuration sync on uploads its settings. Every
device you enable afterwards is overwritten by it — their settings survive only
as conflict copies that Obsidian ignores.

So enable it on your main machine first, alone, let it finish, and only then
switch on the others.

## What is never synced?

Your window layout. `workspace.json` and `workspace-mobile.json` are always
device-local, so your open panes and sidebar widths stay yours per device.

Syncali also refuses to sync its own plugin folder, which is what stops it
overwriting itself mid-run.

## If sync goes wrong, what actually saves me?

Layers, not faith in any one thing.

- **Version history.** Every synced change is kept for your retention window,
  encrypted like everything else. Compare an old version against the current
  file before restoring.
- **Deleted file recovery.** Notes and attachments you delete stay recoverable
  until history expires.
- **Your own backups.** Independent of sync entirely. If sync corrupts
  something, a backup does not care.

We would rather you had all three. Any sync tool that tells you it cannot lose
data has not been running long enough.

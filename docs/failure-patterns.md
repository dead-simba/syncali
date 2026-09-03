# How this thing breaks

A running record of what has actually gone wrong in Syncali, why, and how it
was found. Release notes say what changed for the user; commit messages carry
the reasoning for one change. This file is for the patterns across them — the
things worth knowing before touching the sync engine, and the mistakes worth
not repeating.

Add to it when a bug turns out to be an instance of something, not a one-off.

## Diagnose by measuring, not by reasoning

Every bug below was found by looking at real data. Every wrong theory came from
reasoning about the code without it. The wrong theories were confident and
plausible — file size caps, storage quotas, phone memory, subrequest limits,
cross-vault key mixing — and every one died the moment a measurement arrived.
Some cost hours.

The rule: **before proposing a cause, produce a number that only that cause
explains.**

Where the numbers live:

| Question | How to answer it |
| --- | --- |
| Is anything actually being sent? | `npx wrangler tail` in `apps/api`, count requests per minute |
| Is the server accepting commits? | D1 `vault_sync_status`: `staged_blob_count`, `live_blob_count`, `entry_count`, `last_commit_at` (flushed periodically, so it lags) |
| What does the client think it holds? | `strings` over `~/Library/Application Support/obsidian/IndexedDB/app_obsidian.md_0.indexeddb.leveldb/*.log` — entry rows are readable text |
| Is the engine doing anything at all? | Size of that same `.log` sampled 30 seconds apart. Zero growth means idle |
| What changed on disk and when? | `find . -newermt "-15 minutes"` in the vault |
| What did the user actually see? | Settings → Recent problems, or `.obsidian/plugins/syncali/data.json` → `errorLog` |

A vault that is genuinely idle shows: no requests, no store growth, no file
changes. If the UI disagrees with all three, the bug is in the UI's idea of the
state, not in the sync.

## The shapes that keep recurring

### One item fails, the batch dies

`mapWithConcurrency` is `Promise.all`. One rejection loses the whole batch, and
because the cursor never advances, every retry fails in the same place. The
vault stops syncing over one file.

Found in: filename writes, blob downloads, commits, moved files, metadata
decryption, the vault scan. Each was fixed by isolating the item — skip it,
report it, keep going.

**Still outstanding:** the apply phase in `pull-entry-state-applier.ts` is
deliberately all-or-nothing, guarded by two rollback test suites. If it is ever
changed, those suites are the specification.

### A record that looks settled but never arrived

The worst class, because nothing reports anything. A file's hash matches what
was recorded, nothing is queued, and nothing on the server sits behind it — so
every check agrees it is fine and it silently never syncs.

Caused by a queued upload being dropped (a rename or delete between queueing
and pushing). Both the stat cache and the hash comparison treated it as up to
date. Both now ask whether the file ever actually reached the server.

**The lesson: "unchanged" is not "synced".** Any check that decides to skip work
has to be able to distinguish them.

### Repeating without progress

An action that neither succeeds nor changes the state it is reacting to, run
again every cycle. Costs no network traffic, so it hides from the obvious
measurement, and it never reaches a conclusion.

- A record for an excluded path could only be cleaned up when nothing remote
  pointed at it, so it survived every sweep and was re-swept forever.
- A path collision wrote a conflict copy of a file identical to the one already
  there, which changed nothing, so the next revision collided too — a new copy
  every few seconds.

A fix for one of these can create another. Making the scan stop skipping a
file with nothing on the server behind it fixed files that silently never
synced - and became a loop, because when the upload could not succeed the next
scan met exactly the condition the failure had left behind. A phone uploaded
the same content about fifty-six times a minute, roughly 160,000 requests a
day against a 100,000 request limit.

**Before adding a corrective action, ask what makes it stop.** If it does not
change what triggered it, it will run forever. Anything that retries needs a
bound, and when the bound is reached the user has to be able to see what was
set aside - `Files not syncing` is where that goes.

**Watch the request rate after shipping a retry change.** `npx wrangler tail`
for a minute: an idle vault is a handful of requests, not hundreds.

### The status disagreeing with reality

Users experience this as the bug, whatever the engine is doing.

- Progress counted entries that could never complete: "99% — 1527 / 1529",
  permanently.
- A retry with nothing to retry returned silently, leaving the engine parked in
  `retry_wait`. Idle is only reported at the end of a sync pass, and no pass was
  coming: the spinner ran forever over a finished vault.
- The mobile indicator drew a warning triangle unconditionally at the end of
  `refresh()`, overwriting the state-aware icon set moments earlier.
- "up to date 99% — 1472 / 1474": counts left over from a finished sync.

**Every terminal state needs a path into it from every non-terminal state.**
Being finished is a thing that must be reported, not the absence of activity.

### Names

More bugs than any other single cause.

- Trailing spaces are legal in a vault. Four separate `.trim()` calls broke a
  file named `V2.2 Ground Floor `; fixing one and shipping revealed the next.
  **Grep for every instance of a pattern before claiming it is fixed.**
- Android cannot create filenames containing `?`, `"`, or a carriage return.
  macOS folder icons are a file named `Icon\r`, which failed forever until it
  was excluded.
- The last dot is not always an extension: `V2.2 Ground Floor` put the conflict
  marker mid-name.
- Two devices can hold separate identities for one path. Identical bytes at one
  path are not a conflict and are now adopted rather than copied.

## This vault's known landmines

- `My Knowledge Base/Utilities/Images/V2.2 Ground Floor ` — trailing space.
  Caused the ENOENT crashes, the mangled conflict name, the never-uploaded
  record, and the collision storm. Renaming it would retire the whole class.
- `Icon\r` at the vault root — macOS folder icon, now excluded.
- Conflict copies synced back before conflict copies were excluded. They exist
  remotely and no device will ever write them.
- Entry `9cb68646-0dbe-4e17-a8ce-c69569558cd5` — metadata that would not
  decrypt, cause never established. Skipped and reported; not resolved.

## Where things are recorded

- **Release notes** (`apps/obsidian-plugin/release-notes/next.md`) — what
  changed, for the user, in their language.
- **Commit messages** — why one change was made, and what was observed that
  prompted it. These are the primary record; they are written to be read later.
- **This file** — the pattern across several of them.
- **Settings → Recent problems** — what the user was actually shown, kept on
  disk because a notice lasts seconds and a phone has no console.

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

### Measurements that could not see what they claimed to

Measuring is not enough on its own; the measurement has to be able to detect
the thing. These were all taken, and all misread:

- **"The desktop's store isn't growing, so the desktop is idle."** A push that
  the server keeps rejecting writes almost nothing locally. The desktop was
  uploading one note every 0.9 seconds while its IndexedDB log grew 0 bytes.
  The check was also taken three hours after the traffic it was meant to
  explain.
- **Not reading the device off the traffic.** Every request in a
  `wrangler tail` capture carries a `user-agent` header (`Electron` means the
  desktop app). It was captured, and never looked at, while the phone was
  blamed.
- **A 17-second window reported as "3 uploads a minute".** Short windows on
  bursty traffic say nothing about the rate.
- **Extrapolating 46 seconds to a day.** "160,000 requests a day" assumed a
  loop that actually ran in episodes, and counted Durable Object stage calls as
  Worker requests. A real 24-hour sample was 7,135.
- **"Same 10 blobs" read off a flat `staged_blob_count`.** Blob ids are
  redacted in the tail, and a re-queue reuses the blob id when the content is
  unchanged, so a flat count could not tell two different loops apart.
- **Declaring a fix without re-measuring.** 0.3.26 was shipped with "I'm not
  calling this fixed until I've seen that number", and the number was never
  taken. The loop was still running three weeks later.

A capture worth trusting names the device (user-agent), the object (blob size
is a fingerprint: a v2 envelope is the plaintext plus exactly 33 bytes), and
runs long enough to cover a burst. The plugin's own local store can be decoded
offline from a copy of its leveldb directory, which is how the stuck entry was
finally read instead of guessed.

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

- A commit rejected as stale was treated as progress: the rejection handler
  returned normally, which cleared the failure counter, asked for a pull, and
  looped at once. The pull only rebases a pending change when the page it
  fetches contains that entry, so when the pull could not deliver the newer
  revision - metadata this device cannot decrypt, a remote path this device
  excludes, or a cursor already past the entry - the same note was uploaded
  about once a second, indefinitely. Measured on the desktop: 837 uploads of
  one 13,258-byte note in 12.8 minutes, every one accepted, nothing committed.
  It ran from at least 1 September (0.3.21) until 0.3.27.

That loop was first blamed on 0.3.26's predecessor, the change that made the
scan re-queue files with nothing on the server behind them. It was observed
before that change existed, and 0.3.26's bound on the scan never touched it.
The re-queue did need a bound, but it was not the cause.

Parking that loop's change forgot why it was parked. Every autosave of the
note queued a new change on the same base, which the server rejected with the
same pair of revisions and which therefore started over: two uploads, a fetch
by id and a new notice per save. **Setting something aside has to remember
what it set aside**, or the next instance of it is treated as new.

**A retry path that returns a success-shaped result bypasses its own bound.**
`MAX_COMMIT_ATTEMPTS` only counted rejections that threw. The stale branch
returned normally and was never counted.

**Before adding a corrective action, ask what makes it stop.** If it does not
change what triggered it, it will run forever. Anything that retries needs a
bound, and when the bound is reached the user has to be able to see what was
set aside - `Files not syncing` is where that goes. Since 0.3.27, a sync pass
that pushes nothing, requeues something, and pulls nothing backs off instead of
looping - a safety net for whatever the next non-converging path turns out to
be.

### Transient failures classified as permanent

A retry that is un-done by the next event turns into episodes. The stale loop
did not run continuously: an ordinary network hiccup during an upload
(`net::ERR_CONNECTION_RESET`, `sync token expired`, a 503) was treated as a
permanent failure and parked the note, and the next reconnect un-parked it and
the loop resumed. The error-marker list matched "connection reset" with a
space; Chromium reports `net::ERR_CONNECTION_RESET` with underscores.

**Classify errors against the strings the platform actually produces** - take
them from the user's Recent problems log, not from memory - and keep "offline"
(which drives the status) separate from "try again later" (which drives
retries). Parking is for failures that will happen again; retrying is for
everything else, and it still needs a bound.

The reverse happened too. File-system errors carry the file's path, and a path
is the user's own words: a note under `Offline maps/` matched the offline
markers, so a file the OS would not hand over was retried on every push, with
no count and no parking, and took the push down with it. Local file errors are
now judged by their code before any text is matched.

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
- Entry `a72c4a5a-29ef-44bf-b74a-cbe420a6fc5e` — *The Lean Startup* note. The
  desktop holds an edit based on revision 1 while the server is ahead, and it
  never received the newer revision. This is the note that looped. 0.3.27
  fetches it by id and merges, or sets it aside with the exact reason.

## Where things are recorded

- **Release notes** (`apps/obsidian-plugin/release-notes/next.md`) — what
  changed, for the user, in their language.
- **Commit messages** — why one change was made, and what was observed that
  prompted it. These are the primary record; they are written to be read later.
- **This file** — the pattern across several of them.
- **Settings → Recent problems** — what the user was actually shown, kept on
  disk because a notice lasts seconds and a phone has no console.

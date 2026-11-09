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
| Which devices are signed in, and when were they last used? | D1 `session`: `user_agent` (`Dalvik/… Android` is the phone; the string is fixed when the session is created, so an old Obsidian version there is not the current one) and `updated_at` |
| When did Obsidian on the desktop see a file change? | Obsidian's File Recovery snapshots live in the same leveldb as `path` + `ts` (a V8 double after the bytes `tsN`) + `data`. They are taken on Obsidian's own vault events, so they date what plugins were told |

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
- **Reading Recent problems as a history.** The log collapses an immediate
  repeat into one line and moves its time forward. One line dated 9 November,
  after a gap of five weeks, was a failure that could not have started before
  26 October and recurs on every pull: the time is the last occurrence, not
  the first.
- **A `wrangler tail` with the phone asleep.** Ten minutes, 41 events, none
  from the phone. A capture only sees a device that is running; open Obsidian
  on it for the duration.

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

That makes any name this device cannot create fatal to the pull. A note named
with a `:` stopped the phone's pull from 26 October, when it was uploaded, to
at least 9 November: `write failed for "file:/Users/…": FILE_NOTCREATED`, the
window rolled back, and the cursor never moved. Reproduced against the pull
engine: cursor 0 on three attempts in a row, and nothing after the entry
written. That instance
is fixed upstream of the apply phase - the path is now classified as never
synced, so the planner skips it and the cursor advances - but the general case
is not: a desktop can still upload a real note named with `?`, `"`, `*`, `<`,
`>`, `|` or `\`, and Android will stop on it the same way.

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
now judged by their code before any text is matched. Android's vault write
errors had no code at all (`write failed for "…": FILE_NOTCREATED`), so they
slipped past that check until 0.3.28; they are now local by construction.

**Watch the request rate after shipping a retry change.** `npx wrangler tail`
for a minute: an idle vault is a handful of requests, not hundreds.

### One fix per decision, and every decision that reads the same strings

0.3.27 taught the *retry* classifier Chromium's `net::ERR_…` spelling and left
the *notice* classifier alone. Every Wi-Fi handover went on popping
"Automatic sync failed: net::ERR_CONNECTION_RESET" over a drop the next pass
retried anyway: 66 of the 82 problems recorded across two desktop vaults. The
ones that needed a decision - a note set aside, a note that could not be read,
an edit held back as stale, four conflicts - were buried among them. Counting Recent problems by kind is what found it - the log measures
noise as well as failures.

The obvious fix was wrong. `isOfflineLikeError` reads as "what the status
says", but the push also uses it to decide whether to abandon the whole batch.
Adding Chromium's codes to it would have turned one file that hits the same
reset on every attempt into a push that never gets past it - uncounted, never
set aside, behind a quiet "offline". The push-quarantine tests caught it. The
notice now has its own predicate, `isConnectionDropError`, and the push's is
unchanged.

**Before widening a predicate, list every caller and what each one decides
with it.** A name that describes one use is not a promise there are no others.

**A named error must prove its cause.** "Android does not allow ? in file
names" appears only when both the refusal code and a refused character are
present; a FILE_NOTCREATED from a full disk keeps the generic text rather than
blaming the name. "Syncali will try again on its own" appears only for
automatic sync, because a server failure while creating a vault is not retried.

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
- **A `TFile` is not necessarily in the vault.** Since 1.14, desktop Obsidian
  can open a file from anywhere on disk as a `TExternalFile` (a `TFile`
  subclass) with the path `file:` + its real location, and fires the vault's
  own `modify` and `delete` events for it while it is open. The desktop
  adapter strips `file:` and resolves the rest as an absolute path, so a write
  or delete there reaches the real file. Previewing a draft from another
  project while it was edited elsewhere uploaded it four times. Obsidian's own
  test for these is `path.startsWith("file:")`; Syncali now uses the same one
  and treats the path as never synced.

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
- An entry at `file:/Users/alitahir/Documents/Development/Claude Code/Understanding-Quran-Words/…/behind/2026-10-19-alhamdulillah.md`,
  uploaded by the desktop on 26 October while Obsidian had that file open for
  preview. Still live on the server; devices with the `file:` rule skip it.
  It stopped the phone's pull from then until the fix reached it.

## Checks that fail for reasons outside the code

Know these before reading a red result as a regression.

- **`pnpm -C apps/api test:integration` fails on this machine before any test
  runs**: `No such module ".../Claude%20Code/..."`. The Workers test runner
  URL-encodes the space in the folder name `Claude Code`. CI is unaffected. To
  run them locally, use a checkout whose path has no spaces
  (`git worktree add --detach <path> HEAD`, `pnpm install --frozen-lockfile`)
  and the placeholder values CI sets in `.github/workflows/api-ci.yml`
  (`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `SYNC_TOKEN_SECRET`). On
  9 November that ran 58 of 58.
- **`pnpm -C apps/obsidian-plugin lint` reports about 61 problems, and CI does
  not run it.** Most are Obsidian's popout-window rules (`window.setTimeout`)
  and its warning about a hard-coded `.obsidian`, which the reserved-path
  defaults use on purpose. Judge a change by the count before and after it
  (`git stash`, lint, `git stash pop`), not by the total.

## Where things are recorded

- **Release notes** (`apps/obsidian-plugin/release-notes/next.md`) — what
  changed, for the user, in their language.
- **Commit messages** — why one change was made, and what was observed that
  prompted it. These are the primary record; they are written to be read later.
- **This file** — the pattern across several of them.
- **Settings → Recent problems** — what the user was actually shown, kept on
  disk because a notice lasts seconds and a phone has no console.

# Device reports

Every device running Syncali tells the server how its syncing is going, so a
device that has quietly stopped is visible from the others. Built after a phone
spent two weeks unable to receive anything while every surface said nothing:
the only record was one collapsed line in that phone's own Recent problems.

## What is sent, and who can read it

A device sends a report about a minute after sync connects and then every 10
minutes while Syncali runs. An unchanged report is skipped until an hour has
passed. Opening Settings → Devices always sends a fresh one.

Each report has two halves.

**Readable by the server** (`vault_device_report.report_json` in D1):

| Field | Meaning |
| --- | --- |
| `platform`, `mobile` | android, ios, macos, windows, linux |
| `pluginVersion`, `obsidianVersion` | |
| `status` | the sync status code, e.g. `up_to_date`, `attention_needed` |
| `cursor`, `serverCursor` | how far this device has pulled, and the furthest server position it has heard of |
| `activeSince` | when it last started or resumed trying to sync |
| `lastSyncOkAt`, `lastErrorAt` | when a sync pass last finished with nothing left, and the last error |
| `pendingUploads`, `setAside`, `skippedUnreadable` | counts |
| `problems` | per kind (`name_refused`, `connection_drop`, …): count, first seen, last seen |
| `files` | how many files it holds, and a keyed fingerprint of them |
| `rules` | which file types it syncs, and how many folders it excludes |

The server validates this half strictly: every field is a number, a timestamp
or a short lowercase code, and fields it does not know are dropped rather than
stored. A buggy or newer client cannot put a file name here.

What this half does reveal: how many files you have, when each device syncs,
how far behind it is, which Syncali and Obsidian versions it runs, and what
kinds of problems it has had. The server already sees most of this (entry
counts, request times); the problem kinds and versions are new.

**Readable only with the vault key** (`details_envelope`): the device's label
and vault name, its last 20 Recent problems with their text, the files set
aside, up to 50 files it knows are not in sync yet, and a fingerprint per
top-level folder. Encrypted on the device with AES-GCM under a key derived from
the vault key for this purpose alone (`device-report:v1`). The vault id and the
device id are bound in as additional data, so the server cannot move one
device's details into another's row without decryption failing.

The file fingerprint is an HMAC over each file's path and content hash, keyed
from the vault key (`file-fingerprint:v1`). Two devices with the same files get
the same value; the server cannot test a guess against it.

## Where to read them

- **Settings → Devices** on any device: every device's verdict, reasons, recent
  problems and unsynced files, decrypted.
- **Stuck warning.** Every 30 minutes each device checks the others. One that
  is alive but has not finished a sync for over an hour gets a notice, at most
  once a day per device, and a line in Recent problems.
- **`<vault>/.obsidian/plugins/syncali/device-reports.json`** - the last
  decrypted set, written whenever reports are fetched. Syncali's own folder is
  never synced, so this stays on the device that wrote it.
- **`pnpm sync:doctor`** from the repository root: the server's counters, every
  device's readable report, and the decrypted copies found on this computer, in
  one report. Needs `wrangler login`.

## What the verdicts mean

The rules live in `apps/obsidian-plugin/src/sync/health/device-verdict.ts`,
shared by the plugin and `sync:doctor`.

| Verdict | When |
| --- | --- |
| Stuck | Reported in the last 2 hours, has not finished a sync for over an hour since it last succeeded or started trying, and is behind, needs attention, or has had problems since its last success |
| Catching up | Behind the server, but not stuck |
| Needs attention | Up to date, but files are set aside or would not decrypt |
| Quiet | No report for a day: switched off or asleep, not necessarily broken |
| Up to date | None of the above |

"Started trying" matters: a phone that slept overnight is behind and has not
finished a sync since yesterday, but it has only been trying for a minute.

## Compatibility

The server announces `device_reports` in `hello_ack.features`. A device only
sends reports to a server that announced it, so an older server never sees the
requests. An older device simply never appears in the list.

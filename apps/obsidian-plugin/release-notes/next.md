# Next Obsidian plugin release

## Added

- Sync errors now name the file they failed on, so a single unwritable note is identifiable instead of anonymous.

## Changed

- Renamed to Syncali. The plugin installs to its own folder and keeps its own credentials, so it can sit alongside other sync plugins without either overwriting the other. You will sign in and reconnect your vault once after updating.
- File type rules now apply to files arriving from other devices, not only to files leaving this one. Turning off videos on a phone finally stops that phone downloading them.

## Fixed

- A failed file download no longer discards the entire batch it belonged to. On a slow or unstable mobile connection this could leave sync stuck near completion indefinitely.
- Connection drops reported by Android are treated as a temporary blip and retried quietly, instead of surfacing as a sync failure.
- Sync notices can no longer appear with no message after the colon.
- Prevented outdated remote file versions from overwriting newer local versions during sync.

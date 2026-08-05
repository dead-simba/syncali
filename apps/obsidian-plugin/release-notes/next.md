# Next Obsidian plugin release

## Added

- Mobile now shows sync activity, not only problems. The indicator spins while a sync is running and confirms briefly when one finishes, then gets out of the way.

## Fixed

- The sync status could contradict itself, reading "up to date 99% - 1472 / 1474". Progress counts are only updated while a sync is running, so they lingered after it finished. A finished state now simply says what it is.
- A file whose name begins or ends with a space, such as `V2.2 Ground Floor `, stopped sync with "ENOENT: no such file or directory". Names typed into settings are still trimmed; names read from your vault are now left exactly as they are.
- Sync progress could show more files done than there were to do, such as "1449 / 1448".

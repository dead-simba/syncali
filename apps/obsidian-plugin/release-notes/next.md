# Next Obsidian plugin release

## Fixed

- A file whose name begins or ends with a space, such as `V2.2 Ground Floor `, stopped sync with "ENOENT: no such file or directory". Paths were being trimmed in three separate places, each rewriting the name to one that does not exist. Names typed into settings are still trimmed; names read from your vault are now left exactly as they are.
- Sync progress could show more files done than there were to do, such as "1449 / 1448". The total is counted once when a sync starts, so anything another device saved while it was running was applied without being counted. The total now grows to match instead of reporting an impossible number.

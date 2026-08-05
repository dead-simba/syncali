# Next Obsidian plugin release

## Fixed

- Sync progress could show more files done than there were to do, such as "1449 / 1448". The total is counted once when a sync starts, so anything another device saved while it was running was applied without being counted. The total now grows to match instead of reporting an impossible number.

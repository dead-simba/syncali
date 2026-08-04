# Next Obsidian plugin release

## Fixed

- Renaming, moving or deleting a note while a sync was in flight could stop sync entirely with "File does not exist". The queued change is now recognised as stale and discarded, and the rename or delete that replaced it carries the change instead.
- One unsyncable file no longer stops the others. A file that cannot be prepared for upload is set aside with a reason and the rest of the batch continues, instead of the whole sync halting. Connection problems are still retried rather than set aside, so a dropped connection never parks a file that was fine.
- A file that is not syncing is now shown in the file explorer and counted in settings whatever the reason, not only when it is too large. Previously a file set aside for any other reason was invisible.

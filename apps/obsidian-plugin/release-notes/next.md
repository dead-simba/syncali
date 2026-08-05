# Next Obsidian plugin release

## Fixed

- A change the server kept rejecting was uploaded and rejected again on every retry, indefinitely, while every other change queued behind it waited. Transient rejections are still retried as before, but a change that is plainly not recovering is now set aside so the rest of the vault keeps syncing.
- When a file is set aside you are now told which file it is and what makes Syncali try again, instead of sync quietly continuing without it.

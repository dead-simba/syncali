# Next Obsidian plugin release

## Fixed

- A change the server kept rejecting was uploaded and rejected again on every retry, indefinitely, while every other change queued behind it waited. Transient rejections are still retried as before, but a change that is plainly not recovering is now set aside so the rest of the vault keeps syncing.
- A change that was set aside now gets a fresh attempt every time sync reconnects, instead of waiting for you to happen to edit that file again.
- When a file is set aside you are told which file it is and what makes Syncali try again, instead of sync quietly continuing without it.

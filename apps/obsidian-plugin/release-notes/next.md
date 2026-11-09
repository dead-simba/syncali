# Next Obsidian plugin release

## Added

## Changed

- Errors that need you now say what happened and what to do about it. When your phone cannot create a file because of a character in its name, Syncali names the file and the character: "Could not create "Why?.md" on this device. Android does not allow ? in file or folder names. Rename it on your computer and sync will continue." It used to say "write failed for "Why?.md": FILE_NOTCREATED". When your server fails during automatic sync, Syncali says so, says nothing was lost, and tries again, instead of showing "error code: 1102 (http_503)".

## Fixed

- A dropped connection on your computer no longer shows "Automatic sync failed". When the Wi-Fi changes or your laptop wakes from sleep, Obsidian's desktop app reports the drop as "net::ERR_CONNECTION_RESET" or a similar code, and Syncali showed every one as a failure, though it was already going to try again. On one two-vault setup that was 66 of the last 82 problems recorded. The status now says offline, and sync carries on when the connection is back. Certificate and proxy errors, which you have to fix yourself, still show.

- Previewing a file from outside your vault could stop your phone syncing. Since version 1.14, desktop Obsidian can open a file from anywhere on your computer, and while it is open, Obsidian reports every change to it as though it were a note in your vault. Syncali took that at face value and uploaded the file under its full address on your computer, starting `file:/Users/`. Android does not allow `:` in a filename, so every sync on the phone stopped at that file, and changes from your other devices stopped arriving. Syncali now ignores files Obsidian has open from outside the vault. They are not uploaded, and one that was uploaded before is skipped on the way down, so the rest of your vault comes through. Syncali also refuses to write or delete anything at one of those addresses, because on a computer it points at the real file, not at your vault.

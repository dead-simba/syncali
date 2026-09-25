# Next Obsidian plugin release

## Added

## Changed

## Fixed

- One note could be uploaded about once a second, for minutes at a time. When the server holds a newer version of a note than the one your edit was based on, Syncali pulls that version down and tries again. When the pull cannot bring it down - it will not decrypt on this device, it sits in a folder this device does not sync, or this device had already read past it - the next try was rejected the same way, and the one after. One 13 KB note went up 837 times in 13 minutes. Syncali now notices the same rejection coming back, asks the server for that one note directly (on servers that support it) and settles it the way a pull would - merged, or both versions kept. If that still does not settle it, Syncali sets the note aside under Files not syncing with the reason. Your edit stays in the file on your device. Try these again brings it back. A delete set aside this way is listed too, since there is no file left to edit.
- A dropped connection or a busy server could set a good file aside. Errors worded the way Obsidian's desktop app words them ("net::ERR_CONNECTION_RESET", "net::ERR_NETWORK_CHANGED"), an expired sync token, and server errors such as "error code: 1102" are now retried later instead of being blamed on the file. Only that file waits, so the rest of your vault keeps syncing. A file that fails five times in a row is set aside, and tried again the next time Syncali reconnects.
- A sync pass that changes nothing now waits before the next one, starting at a second and backing off to thirty, instead of going round again at once. Changes arriving from your other devices still come down during that wait, but no longer cut it short.

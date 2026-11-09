# Next Obsidian plugin release

## Added

- Settings → Devices shows how each of your devices is syncing: when it last finished a sync, how far behind the server it is, what went wrong and which files are not in sync, in that device's own words. Each device sends a short report every 10 minutes while Syncali runs. File names and error messages are encrypted on the device, so your server stores them without being able to read them. What your server can read: how many files each device holds, when it syncs, which Syncali and Obsidian versions it runs, and what kinds of problems it has had. Needs your server updated to keep reports; with an older server the Devices list stays empty and nothing else changes.
- If one of your devices is running but has not finished a sync for over an hour, your other devices tell you, once a day: "Your Android phone has not finished a sync since 26 Oct. Open Syncali settings, then Devices, to see why." A phone that stopped receiving changes went unnoticed for two weeks before this.

## Changed

- Recent problems now says how long a repeated problem has been happening. A problem that came back 1,400 times used to show as one line with today's time; it now reads "1,400 times since 26 Oct".

## Fixed

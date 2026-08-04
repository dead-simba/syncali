# Showcase media

Clips referenced by the homepage showcase (`home.showcase` in `src/i18n.ts`).
Until a file exists here the card renders the expected filename instead of a
broken player, so the page is always shippable.

| File | Shows |
| --- | --- |
| `desktop-to-mobile.mp4` | A line typed on desktop appearing on the phone |
| `deleted-files.mp4` | Recovering a deleted note from the Deleted files panel |
| `version-history.mp4` | Comparing an older version, then restoring it |
| `conflict-merge.mp4` | The same note edited on two devices, merged |

Each needs a matching `.webp` poster of the same name — it is what shows before
the clip loads and on slow connections.

## Recording

- Silent. They autoplay muted and loop; anything needing narration belongs in a
  blog post.
- 6-12 seconds. Long enough to follow, short enough to loop without irritating.
- 16:9, at least 1280x720. The cards are `aspect-video`.
- Trim hard. Start on the action, not on a cursor travelling to a menu.
- Keep total weight sensible - these autoplay, so several megabytes each is a
  real cost to a first-time visitor on mobile.

```sh
# reasonable web encode from a screen recording
ffmpeg -i raw.mov -vf "scale=1280:-2" -c:v libx264 -crf 26 -preset slow \
  -movflags +faststart -an desktop-to-mobile.mp4

# poster from the first frame
ffmpeg -i desktop-to-mobile.mp4 -vframes 1 -q:v 80 desktop-to-mobile.webp
```

# Syncali

Sync your Obsidian vault between your computers and your phone. Everything is
encrypted on your device before it leaves, so the server stores nothing
readable. Run it on Cloudflare's free tier and it costs you nothing.

Syncali is a fork of [Synch](https://github.com/hjinco/synch) by hjinco, MIT
licensed. The sync engine and the encryption design are theirs.

Syncali is an independent community plugin. It is not affiliated with Obsidian.

## Install

Syncali is not in Obsidian's community plugin directory. Install it with
[BRAT](https://github.com/TfTHacker/obsidian42-brat), Obsidian's beta plugin
installer:

1. Open **Settings → Community plugins**, turn off Restricted mode
2. **Browse**, install **BRAT**, enable it
3. In BRAT, choose **Add beta plugin** and paste `dead-simba/syncali`
4. Enable **Syncali**

To install by hand instead, download `main.js`, `manifest.json` and
`styles.css` from a [release](https://github.com/dead-simba/syncali/releases) and
drop them into `YourVault/.obsidian/plugins/syncali/`.

## Connect it to a server

1. **Settings → Syncali → Use a self-hosted server**, enter your server URL
2. Sign in — your email must be listed in the server's `AUTH_ALLOWED_EMAILS`
3. **Create vault**, or **Connect vault** if one already exists
4. Choose a vault password. It never leaves your device, and nobody can reset
   it for you

The vault password derives the key your files are encrypted with. Lose it and
the data is gone — that is the point of end-to-end encryption, and the one
tradeoff worth being certain you accept.

## Run your own server

- [Cloudflare](https://synch.run/self-hosting) — free tier, a few minutes
- [Docker / systemd](https://synch.run/self-hosting-docker) — your own hardware

Self-hosted deployments have no storage cap, no file size cap and no vault
limit.

## What syncs

Markdown always. Images, audio, video and PDFs are on by default; other file
types are off. Hidden folders are skipped unless you opt in.

**File type rules are per device.** Turning off video on a phone stops that
phone both uploading and downloading video, while your desktop keeps
everything.

Optionally, Syncali can also sync your vault configuration — settings, theme,
snippets, hotkeys, and community plugins. That is off by default and each part
is a separate toggle.

## What is protected, and what is not

Your file contents and file paths are encrypted on your device before upload.
The server cannot read them.

The server does see file sizes, timestamps, how much you store, vault and
device identifiers, and IP addresses. Encryption hides your notes, not the fact
that you have them.

## Known limitations

- **No collaboration.** One account, your own devices.
- **Large attachments are hard on phones.** A pull loads a batch of files into
  memory at once, which a phone can struggle with when a single file is tens of
  megabytes. Excluding video per device is the workaround.
- **One unwritable file blocks the rest.** If a file cannot be written — an
  Android filename containing `" * : < > ? \ |`, for instance — sync stops
  until it is renamed. The error names the file.

## Development

```sh
pnpm install
pnpm -C apps/obsidian-plugin test        # 467 tests
pnpm -C apps/obsidian-plugin typecheck
pnpm -C apps/obsidian-plugin build

pnpm -C apps/api test:unit
pnpm -C apps/api test:integration        # needs a checkout path without spaces
```

Set `OBSIDIAN_PLUGIN_DIR` in `apps/obsidian-plugin/.env` to a scratch vault's
plugin folder and `pnpm dev:plugin` copies each rebuild straight into it.

User-facing text follows [docs/copy-style.md](docs/copy-style.md).

## Licence

MIT. See [LICENSE](LICENSE) — it carries hjinco's copyright for the original
work alongside ours for the modifications, which is what MIT requires of a
derivative.

# MBP Native Player

A [TizenBrew](https://github.com/reisxd/TizenBrew) site mod that gives
MovieBoxPro a TV-shaped player on Samsung sets.

Browsing and search stay the site's own — the mod is invisible until you open
a title, then replaces the player with one built for a remote.

## What it does

- **D-pad transport** — OK play/pause, Left/Right 10s, FF/RW 60s
- **Quality** on Up/Down, with HEVC and AV1 gated on what the set can decode
- **Subtitles** on Green: a language picker and a delay you can nudge in
  half-second steps
- **Skip intro / outro** when the title has skip points
- **Next episode** on Yellow, and automatically when one ends
- **Resume across standby** — detects the set having slept and refreshes an
  expired stream link rather than leaving a dead player
- **Diagnostics** on Blue: engine version, timings, dropped frames and codec
  support, on one screen

## Installing

Add this as a module in TizenBrew:

```
gh/yankygdev-design/mbp-native-player-dist@v0.2.0
```

**Use a tag, not a branch.** jsDelivr caches a `@main` URL for hours, so after
an update a branch URL can keep serving the previous build — and you end up
testing code that no longer exists. A tag is immutable, so it is cached
permanently and is always the build you asked for.

If you do pin to a branch and need the cache cleared:

```
https://purge.jsdelivr.net/gh/yankygdev-design/mbp-native-player-dist@main/userScript.js
```

The **Blue** screen shows the version and build id it is actually running. If
that does not match what you expect, the cache is the answer.

## Keys

| Key | Does |
|---|---|
| OK | Play / pause |
| Left / Right | Back / forward 10 seconds |
| Rewind / Fast-forward | 60 seconds |
| Up / Down | Change quality |
| Green | Subtitles: language and delay |
| Yellow | Next episode |
| Blue | Diagnostics |
| Back | Close a panel, or leave the player |

## Requirements

A Samsung TV running TizenBrew, and a MovieBoxPro account. If the session has
expired the mod shows an 8-digit code to enter on a device already signed in.

## Licence

MIT — see [LICENSE](LICENSE).

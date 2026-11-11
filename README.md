# MBP Native Player

A [TizenBrew](https://github.com/reisxd/TizenBrew) site mod that gives
MovieBoxPro a TV-shaped player on Samsung sets, and a D-pad you can reach it
with.

## What it does

**Browse with the remote.** The site is built for a phone, and on a TV most of
it cannot be selected at all. This puts an outline on screen, moves it with
the arrows, and opens things with OK — including the sign-in links on the
signed-out page, which the site hangs off a bare image that nothing else can
find.

**Then get out of the way.** Open a title and the player takes over by itself.
There is no mode to switch.

- **D-pad transport** — OK play/pause, Left/Right 10s, FF/RW 60s
- **Quality** on Up/Down, with HEVC and AV1 gated on what the set can decode
- **Subtitles** on Green: a language picker and a delay you can nudge in
  half-second steps
- **Skip intro / outro** when the title has skip points
- **Next episode** on Yellow, and automatically when one ends
- **Resume across standby** — detects the set having slept and refreshes an
  expired stream link rather than leaving a dead player
- **Page size** on Blue, because the site caps itself at 750px wide and
  renders tiny on a 1080p panel
- **Diagnostics** on Blue during playback: engine version, timings, dropped
  frames and codec support, on one screen

## Installing

Add this as a module in TizenBrew:

```
gh/yankygdev-design/mbp-native-player-dist@v0.3.0
```

**Use a tag, not a branch.** jsDelivr caches a `@main` URL for hours, so after
an update a branch URL can keep serving the previous build — and you end up
testing code that no longer exists. A tag is cached permanently and is always
the build you asked for.

The flip side is worth knowing: a tag is immutable, not current. If a tag is
older than the work, it serves the older work. The **Blue** screen shows the
version and build id actually running, so check there before believing
anything about what is installed.

If you do pin to a branch and need the cache cleared:

```
https://purge.jsdelivr.net/gh/yankygdev-design/mbp-native-player-dist@main/userScript.js
```

## Keys

While browsing:

| Key | Does |
|---|---|
| Arrows | Move the outline |
| OK | Open what is selected |
| Back | Back a page |
| Blue | Key list, and page size with Left/Right |

While playing:

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

A Samsung TV running TizenBrew, and a MovieBoxPro account. You can sign in
from inside the module: on the signed-out page, the small "more" dots under
the Google button reveal code and QR sign-in.

## Status

Early. The player has had one run on real hardware and the navigation none, so
expect rough edges and please say what you hit.

## Licence

MIT — see [LICENSE](LICENSE).

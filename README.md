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
- **One settings panel**, on a held **OK** (or Up/Down): quality, subtitles,
  subtitle delay, next episode and diagnostics in one place, with Up/Down to
  choose a row and Left/Right to change it
- **Conservative quality by default** — starts at 1080p or below with the
  newer codecs off, and lets you climb from the panel. A codec string is the
  decoder saying it can, not evidence that it does, so anything higher is
  marked as unproven and can always be stepped back down
- **Subtitles** with a language picker and a delay you can nudge in
  half-second steps
- **Skip intro / outro** when the title has skip points
- **Next episode** on Yellow, and automatically when one ends
- **Resume across standby** — detects the set having slept and refreshes an
  expired stream link rather than leaving a dead player
- **Page size** on Blue. The site caps its own layout at 750px wide, and this
  lifts that cap — but only partly, and how much is still unmeasured.
  Its stylesheet specifies about three quarters of its sizes in plain `px`,
  which no root font size can move, so expect this to change some of the page
  and not all of it. 100% leaves the site completely alone
- **Diagnostics** on Blue during playback: engine version, timings, dropped
  frames and codec support, on one screen

## Installing

Add this as a module in TizenBrew:

```
gh/yankygdev-design/mbp-native-player-dist@v0.4.0
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
| OK, held | Settings |
| Up / Down | Settings |
| Left / Right | Back / forward 10 seconds |
| Rewind / Fast-forward | 60 seconds |
| Green | Settings, on the subtitles row |
| Yellow | Next episode |
| Blue | Diagnostics |
| Back | Close a panel, or leave the player |

## Requirements

A Samsung TV running TizenBrew, and a MovieBoxPro account. You can sign in
from inside the module: on the signed-out page, the small "more" dots under
the Google button reveal code and QR sign-in.

## Status

Early, and essentially untested on a TV. There has been exactly one attempt on
real hardware, and it got no further than the signed-out page — which is why
the navigation described above exists. **Nothing here has yet played a video on
a Samsung set.** Expect rough edges, and please say what you hit.

## Licence

MIT — see [LICENSE](LICENSE).

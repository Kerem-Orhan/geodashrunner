# Savefile Runner

Play Geometry Dash levels in the browser, straight from your own save file.

Nothing from the game ships with this page. Each player adds their own files: the save
(which holds every level they've downloaded), the level's song, and optionally the game's
sprite sheets and fonts. Everything is read inside the browser tab and never uploaded.

**Live page:** https://kerem-orhan.github.io/geodashrunner/ (once GitHub Pages is on: Settings → Pages → Deploy from a branch → `main`, folder `/docs`).

## Using it

1. Open the page in Chrome or Edge.
2. Click **Add a folder** and pick your `GeometryDash` folder (`%LOCALAPPDATA%\GeometryDash` on Windows).
3. Click **Add a folder** again and pick the game's `Resources` folder
   (`Steam\steamapps\common\Geometry Dash\Resources`). Optional: without it, levels draw as simple shapes.
4. Pick a level, choose a start position, and press **Play** or **Practice**.

Controls: `Space`, `↑`, or click to jump · `R` restart · `Esc` menu.
Practice: `Z` checkpoint · `X` remove checkpoint · `N` noclip · `H` hitboxes.

## What's in here

| Path | What it is |
| --- | --- |
| `src/core.js` | Engine: save decoding, level parsing, 240 Hz physics, triggers. No browser code, so it runs in Node too. |
| `src/app.js` | Front end: file intake, WebGL renderer, audio-clock sync, input, practice tools, HUD. |
| `src/page.html` | Page layout and styles, with placeholders the build fills in. |
| `data/objclass.json` | Which objects are solid, deadly, slopes, orbs, pads, portals, or triggers, with hitboxes. |
| `data/rendertab.json` | Object ID → sprite frame, layer, default colors, and sub-pieces (adapted from gdrweb). |
| `tools/` | Scripts that regenerate the two data tables. |
| `docs/index.html` | The built single-file page that GitHub Pages serves. |

## Building

```
node build.js
```

This inlines the engine, front end, and data tables into `docs/index.html`, then syntax-checks
every script in it. No dependencies.

## Accuracy notes

- Physics values (speeds, gravity, jump strength, orb and pad forces, hitboxes) are independent
  approximations tuned by feel, not taken from the game.
- Implemented triggers: move, rotate, alpha, toggle, spawn, stop, color. Pulses, camera triggers,
  shaders, and particle effects are not implemented.
- Object classification uses sprite-family rules plus the creator's No Touch flag; some objects
  may still be classed wrong. Hitbox view (`H` in practice) helps spot them.

## Credits

Object sprite table adapted from [gdrweb](https://github.com/IliasHDZ/gdrweb) by IliasHDZ,
MIT License (see `THIRD_PARTY_NOTICES.md`). Not affiliated with RobTop Games.

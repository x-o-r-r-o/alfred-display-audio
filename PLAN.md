# Display & Audio Control — Plan

**Priority tier:** 2 · **Bundle ID:** `io.github.x-o-r-r-o.display-audio` · **Keywords:** `res`, `bright`, `layout`, `audio`, `mic`, `anc`

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-26):

| Raycast extension | Downloads |
|---|---|
| Set Audio Device | 75,001 |
| AirPods Noise Control | 9,020 |
| displayplacer | 8,967 |
| Mute Microphone | 7,595 |
| Display Modes | 7,061 |
| Brightness Control | 6,311 |
| BetterDisplay | 5,899 |
| **Total** | **119,854** |

**Alfred today:** Audio Switcher (2023) and mic mute exist; resolution/brightness workflows are 2013–14 and broken on Apple Silicon; no displayplacer or BetterDisplay.

## Features (v1.0)
- [x] `res` list display modes per monitor and switch (CoreGraphics through the JXA bridge, HiDPI modes via `kCGDisplayShowDuplicateLowResolutionModes`)
- [x] `bright <0-100>` built-in and Apple displays (DisplayServices); external via BetterDisplay CLI or m1ddc if present
- [x] `layout` save/restore monitor arrangements (native CGConfigureDisplayOrigin/mode/mirroring; displayplacer when installed)
- [x] `audio` switch output/input device (CoreAudio), volume; `mic` toggle mute with notification + Hotkey
- [x] `anc` AirPods noise control / transparency / adaptive / off (Control Center UI scripting, locale-independent) + Hotkey

## Tech
- **Stack:** JXA with the ObjC bridge (CoreGraphics / CoreAudio / IOKit) + zsh — avoids a compiled binary, which the Gallery requires to be signed and notarised.
- **Dependencies:** none required. Optional: BetterDisplay or m1ddc (external display brightness), displayplacer (arrangements with rotation). Accessibility permission for `anc`.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel.

## Implementation notes (v1.0)
- JXA bridge: structs (AudioObjectPropertyAddress, UInt32 out-params) go through NSMutableData byte buffers; CFStringRef out-params bind as `id *`; CGDisplayConfigRef is held in a `void **` Ref; the HiDPI option key's real value is `"kCGDisplayResolution"`.
- Verified on real hardware read-only (macOS 27, Apple silicon): device listing, display modes, brightness read. Setters were verified only in dry-run (`DA_DRY_RUN=1`) plus no-op calls (process-local CoreAudio property, `setVolume` with the current value).
- `anc` recognises the Sound menu rows by Control Center's own labels, read from `ControlCenter.app/Contents/Resources/{ListeningMode,Sound}.loctable` in the user's language (falls back to English names and row structure when the tables are missing).
- m1ddc: `display list detailed` + `display id=<CGDisplayID>` (m1ddc 1.2.0, checked against its source); BetterDisplay: `get|set -displayID=N -feature=brightness [-value=0.70]` (wiki "Integration features, CLI" + the Raycast extension); displayplacer: args from the last `displayplacer "…"` line of `displayplacer list` (README v1.4 format).
- Not verified on real hardware: the Control Center automation for `anc` (no AirPods connected; on macOS 27 System Events saw no menu bar items from this terminal), the CoreAudio mute switch for USB microphones, the two CLIs against real monitors, and brightness on Intel Macs (DisplayServices is present there too, but untested).
- To check in real Alfred before release: `anc` with AirPods Pro/Max in English and another language; `res` switch and restore; `layout` restore with two displays; `bright` on an external display.

## Round 4 (post-release audit, 2026-09-27)
- Alfred runtime: every Script Filter and action run through `/bin/bash` with `env -i` (PATH=/usr/bin:/bin:/usr/sbin:/sbin, no LANG) and Alfred's variables with spaced paths, on a fresh install: all fine (UTF-8 argv, JSON, data folder created on demand, 120–220 ms per keystroke). Optional CLIs never came from PATH; the search list now also covers Nix and `~/bin`.
- `v1.0.0` state files (`layouts.json`, `mic.json`, `anc.json`) are unchanged; `hidden.json` and `confirm-delete.json` are new and optional.
- macOS 13–15 Control Center (from the Raycast airpods-noise-control history, PR #15120, and AX dumps in matthiskeuler/airpods-anc-toggle and dchersey/air-defense): menu extras live in ControlCenter (MenuBarAgent on 27, popovers still in ControlCenter); device rows carry `sound-device-<name>` and the disclosure triangle follows the row on 15+, but precedes it on 13/14. Added: find the Sound extra by its localised description when it has no identifier; expand the selected output without identifiers (triangle before the row); a 5 s limit on the popover search and closing only the windows the script opened. Still **unverified on real hardware** for 13/14/15.
- Implemented: `audio`/`mic` steps (`+10`, `-10`); ⌥↩ output and input together (AirPods' two CoreAudio devices are paired by UID); ⌃↩ hide devices with a `hidden` view; `layout` ⌥↩ now asks before deleting; BetterDisplay reported as "open BetterDisplay" when `betterdisplaycli` is installed but the app isn't running; built-in brightness no longer depends on `DisplayServicesCanChangeBrightness`; actions print nothing at all when silent.
- `ListeningMode.loctable` may be missing on older macOS: then only English labels and the row structure are used (other languages rely on `sound-device-*` identifiers).

## Ideas for v1.1
Ranked by value/risk (sources: raycast/extensions issues for audio-device, mute-microphone, display-modes, displayplacer, airpods-noise-control; Alfred Gallery Audio Switcher and Resolution Changer):
1. Favourite output/input devices with Hotkeys to switch to each and to toggle between two (Audio Switcher, Raycast favourites and "combos").
2. Favourite resolutions per display and a Hotkey to toggle between two modes (display-modes #12857, #17619; Resolution Changer).
3. ⌘↩ sets the alert device explicitly, which ends macOS's "follow the selected output" mode (raycast #25075): offer a way back or explain it in the subtitle.
4. Conversation Awareness on/off in `anc` (same Sound menu section); a configurable cycle of modes for the Hotkey (airpods-noise-control #5649).
5. `anc`: restore the previously frontmost app after closing the Sound menu; handle an auto-hidden menu bar (#25157).
6. Input source switching (DDC) through m1ddc / BetterDisplay (betterdisplay #24253).
7. BetterDisplay: address displays by tagID/UUID instead of the displayID it documents as changeable (resolved at ↩ today, so low impact).
8. Mono audio and balance toggles (Audio Switcher #10).
9. AirPlay / HomePod outputs that aren't connected yet (needs private API; high risk).

## Milestones
1. [x] Script filter prototype for the main keyword
2. [x] Actions + modifiers, Universal Actions / File Actions where relevant
3. [x] Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `build.sh` release, forum post, then Gallery submission when invited

## Release checklist (Alfred forum + Gallery)
Sources: alfred.app/submit, alfred.app/submit/styleguide, alfred.app/submit/screenshots, alfredforum.com topics 23976 and 23388.

- [x] README starts with `## Usage` (after a genuine `## Setup`: Accessibility permission for `anc`); each paragraph ends "via the `kw` keyword" / "via the Universal Action"
- [ ] A clean screenshot (window only, transparent background, real-looking data, no other workflows) after each paragraph, stored in `images/`
- [x] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`; Quick Look written as <kbd>⌘</kbd><kbd>Y</kbd>
- [x] `## Setup` only for genuine manual steps (no app installs or API keys; the Gallery lists those)
- [x] Every keyword is ≥ 3 characters and configurable via `{var:keyword_*}`
- [x] Settings in Workflow Configuration; the info.plist `readme` (About This Workflow) matches README.md
- [x] Main icon ≥ 256×256 px
- [x] No self-updater; never download or install software (no pip/brew/curl of binaries); dependencies declared for Alfred to handle
- [x] Any compiled binary is Developer ID signed + notarised; never strip quarantine (none shipped)
- [x] No hard-coded paths; `prefs.plist` is git-ignored; secrets stay in Keychain
- [ ] AI assistance disclosed in the README and the forum post
- [ ] Version bumped in `src/info.plist`; `./build.sh`; GitHub release with the `.alfredworkflow` attached
- [ ] Forum post in "Share your Workflows" with a screenshot, keywords, and the GitHub link

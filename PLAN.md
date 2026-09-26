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
- Not verified on real hardware: the Control Center automation for `anc` (no AirPods connected; macOS 27 moved menu extras to MenuBarAgent), BetterDisplay's CLI syntax (`-displayID`, `-feature=brightness`, taken from the Raycast extension) and m1ddc's `display list` format.
- To check in real Alfred before release: `anc` with AirPods Pro/Max in English and another language; `res` switch and restore; `layout` restore with two displays; `bright` on an external display.

## Milestones
1. [x] Script filter prototype for the main keyword
2. [x] Actions + modifiers, Universal Actions / File Actions where relevant
3. [x] Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `build.sh` release, forum post, then Gallery submission when invited

## Release checklist (Alfred forum + Gallery)
Sources: alfred.app/submit, alfred.app/submit/styleguide, alfred.app/submit/screenshots, alfredforum.com topics 23976 and 23388.

- [x] README starts with `## Usage`; each paragraph ends "via the `kw` keyword" / "via the Universal Action"
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

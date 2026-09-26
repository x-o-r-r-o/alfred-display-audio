# Display & Audio Control — Plan

**Priority tier:** 2 · **Bundle ID:** `com.xorro.display-audio`

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
- [ ] `res` list display modes per monitor and switch (CoreGraphics via Swift helper)
- [ ] `bright <0-100>` built-in + external (DDC via BetterDisplay CLI if present)
- [ ] `layout` save/restore monitor arrangements (displayplacer-compatible)
- [ ] `audio` switch output/input device; `mic` toggle mute with notification
- [ ] `anc` AirPods noise control / transparency / adaptive

## Tech
- **Stack:** Small universal Swift helper binary + zsh.
- **Dependencies:** BetterDisplay optional.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel (universal binaries for any Swift helpers).

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `build.sh` release, submit to Alfred Gallery + forum post

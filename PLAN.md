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
- [ ] `res` list display modes per monitor and switch (CoreGraphics via Swift helper)
- [ ] `bright <0-100>` built-in + external (DDC via BetterDisplay CLI if present)
- [ ] `layout` save/restore monitor arrangements (displayplacer-compatible)
- [ ] `audio` switch output/input device; `mic` toggle mute with notification
- [ ] `anc` AirPods noise control / transparency / adaptive

## Tech
- **Stack:** JXA with the ObjC bridge (CoreGraphics / CoreAudio / IOKit) + zsh — avoids a compiled binary, which the Gallery requires to be signed and notarised.
- **Dependencies:** BetterDisplay optional.
- Output via Alfred Script Filter JSON; settings via Workflow Configuration (`userconfigurationconfig`).
- Secrets (API keys/tokens) in the macOS Keychain, never in `prefs.plist`.
- Target: macOS 13+ on Apple Silicon and Intel.

## Milestones
1. Script filter prototype for the main keyword
2. Actions + modifiers, Universal Actions / File Actions where relevant
3. Workflow Configuration, icons, error states (no network / missing dependency)
4. README with screenshots, `build.sh` release, forum post, then Gallery submission when invited

## Release checklist (Alfred forum + Gallery)
Sources: alfred.app/submit, alfred.app/submit/styleguide, alfred.app/submit/screenshots, alfredforum.com topics 23976 and 23388.

- [ ] README starts with `## Usage`; each paragraph ends "via the `kw` keyword" / "via the Universal Action"
- [ ] A clean screenshot (window only, transparent background, real-looking data, no other workflows) after each paragraph, stored in `images/`
- [ ] Modifiers listed as `* <kbd>⌘</kbd><kbd>↩</kbd> Action.`; Quick Look written as <kbd>⌘</kbd><kbd>Y</kbd>
- [ ] `## Setup` only for genuine manual steps (no app installs or API keys; the Gallery lists those)
- [ ] Every keyword is ≥ 3 characters and configurable via `{var:keyword_*}`
- [ ] Settings in Workflow Configuration; the info.plist `readme` (About This Workflow) matches README.md
- [ ] Main icon ≥ 256×256 px
- [ ] No self-updater; never download or install software (no pip/brew/curl of binaries); dependencies declared for Alfred to handle
- [ ] Any compiled binary is Developer ID signed + notarised; never strip quarantine
- [ ] No hard-coded paths; `prefs.plist` is git-ignored; secrets stay in Keychain
- [ ] AI assistance disclosed in the README and the forum post
- [ ] Version bumped in `src/info.plist`; `./build.sh`; GitHub release with the `.alfredworkflow` attached
- [ ] Forum post in "Share your Workflows" with a screenshot, keywords, and the GitHub link

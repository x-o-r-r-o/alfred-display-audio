#!/bin/zsh
# Package src/ into dist/alfred-display-audio-<version>.alfredworkflow (see tools/build.py)
set -euo pipefail
cd "${0:A:h}"
python3 tools/build.py --package

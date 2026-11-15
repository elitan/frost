#!/bin/bash
# Builds the frost-activator image for this machine. Releases publish it as
# ghcr.io/elitan/frost-activator:<version> (see .github/workflows/release.yml).
# Usage: ./build.sh            -> frost-activator:dev
#        IMAGE=name:tag ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
docker build -q -t "${IMAGE:-frost-activator:dev}" .

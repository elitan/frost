#!/bin/bash
# Cross-compiles a static Linux binary with rustup + rust-lld and builds the
# frost-activator image. Usage: ./build.sh [arch]  (arch: aarch64 | x86_64)
set -euo pipefail
cd "$(dirname "$0")"
ARCH="${1:-$(uname -m | sed 's/arm64/aarch64/')}"
TARGET="${ARCH}-unknown-linux-musl"
CARGO="$(rustup which cargo)"
export PATH="$(dirname "$CARGO"):$PATH"
TARGET_ENV="CARGO_TARGET_$(echo "$TARGET" | tr 'a-z-' 'A-Z_')_LINKER"
export "$TARGET_ENV=rust-lld"
cargo build --release --target "$TARGET"
cp "target/$TARGET/release/frost-activator" ./frost-activator
docker build -q -t "${IMAGE:-frost-activator:dev}" .
rm -f ./frost-activator

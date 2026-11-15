# frost-activator: a static binary in an otherwise empty image (~700 kB).
# Cross-compiles on the build machine's architecture, so multi-arch builds
# (docker buildx --platform linux/amd64,linux/arm64) don't need emulation.
FROM --platform=$BUILDPLATFORM rust:1.83-alpine AS build
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) echo x86_64-unknown-linux-musl ;; \
      arm64) echo aarch64-unknown-linux-musl ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac > /rust-target \
 && rustup target add "$(cat /rust-target)"
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN target="$(cat /rust-target)" \
 && export "CARGO_TARGET_$(echo "$target" | tr 'a-z-' 'A-Z_')_LINKER=rust-lld" \
 && cargo build --release --locked --target "$target" \
 && cp "target/$target/release/frost-activator" /frost-activator

FROM scratch
LABEL org.opencontainers.image.source="https://github.com/elitan/frost"
LABEL org.opencontainers.image.description="Frost scale-to-zero wake proxy"
COPY --from=build /frost-activator /frost-activator
USER 65534:65534
ENTRYPOINT ["/frost-activator"]

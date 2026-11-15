# Image for a prebuilt static binary (see build.sh). The final image contains
# nothing but the binary.
FROM scratch
COPY frost-activator /frost-activator
USER 65534:65534
ENTRYPOINT ["/frost-activator"]

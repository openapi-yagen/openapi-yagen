# syntax=docker/dockerfile:1
#
# Runtime image published to GitHub Container Registry as ghcr.io/openapi-yagen/openapi-yagen -
# unlike Dockerfile.musl (a build environment whose output is extracted onto the host), this image
# is meant to be run directly, e.g. on macOS where no native binary is published:
#
#   docker run --rm -v "$PWD":/workspace ghcr.io/openapi-yagen/openapi-yagen generate openapi.yaml -g builtin:kotlin_ktor_client -o out
#
# Does no C++ compiling of its own: linux-amd64/linux-arm64 CI jobs already produce the exact
# static binaries this needs (dist/openapi-yagen-linux-<amd64|arm64> in the build context) -
# recompiling them a second time here just to throw the sources away would double CI compute for
# no benefit. To build this image yourself: build the CLI per AGENTS.md's "Local build" section,
# then `mkdir -p dist && cp build/cli/openapi-yagen dist/openapi-yagen-linux-$(dpkg --print-architecture)`
# (or the arch-appropriate equivalent) before `docker build`.

FROM alpine:3.21

# curl is required for loading generators from an HTTP(S) URL (-g https://...); ca-certificates
# lets that curl call verify TLS certs.
RUN apk add --no-cache curl ca-certificates

ARG TARGETARCH
COPY dist/openapi-yagen-linux-${TARGETARCH} /usr/local/bin/openapi-yagen
RUN chmod +x /usr/local/bin/openapi-yagen

WORKDIR /workspace
ENTRYPOINT ["openapi-yagen"]
CMD ["--help"]

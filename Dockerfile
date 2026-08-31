# syntax=docker/dockerfile:1
#
# Runtime image published to GitHub Container Registry as ghcr.io/openapi-yagen/openapi-yagen -
# unlike Dockerfile.musl (a build environment whose output is extracted onto the host), this image
# is meant to be run directly, e.g. on macOS where no native binary is published:
#
#   docker run --rm -v "$PWD":/workspace ghcr.io/openapi-yagen/openapi-yagen generate openapi.yaml -g builtin:kotlin_ktor_client -o out

FROM alpine:3.21 AS build

# Building linux/amd64 and linux/arm64 in one `docker buildx build --platform amd64,arm64`
# invocation runs both platforms' RUN steps concurrently. Without a per-arch id, both would share
# the *same* BuildKit cache mount (id defaults to the mount target, identical here regardless of
# platform), racing to write two different architectures' packages/profile into one Conan cache -
# corrupting it for whichever platform loses the race ("Library 'yaml-cpp' not found in package"
# at the cmake step, despite conan install having "just" installed it).
ARG TARGETARCH

RUN set -x && \
    apk add --no-cache cmake py3-pip g++ make samurai git && \
    pip install conan --break-system-packages

RUN --mount=type=cache,target=/root/.conan2,id=conan-${TARGETARCH} \
    conan profile detect --force

COPY conanfile.txt /sources/

RUN --mount=type=cache,target=/root/.conan2,id=conan-${TARGETARCH} set -x && \
    mkdir -p /build && \
    cd /build && \
    conan install /sources -s compiler.cppstd=20 --output-folder=. --build=missing

COPY . /sources/

RUN --mount=type=cache,target=/root/.conan2,id=conan-${TARGETARCH} set -x && \
    cd /build && \
    cmake /sources -DCMAKE_TOOLCHAIN_FILE=conan_toolchain.cmake -DCMAKE_BUILD_TYPE=Release -G Ninja && \
    cmake --build . --target openapi-yagen

FROM alpine:3.21

# curl is required for loading generators from an HTTP(S) URL (-g https://...); ca-certificates
# lets that curl call verify TLS certs.
RUN apk add --no-cache curl ca-certificates

COPY --from=build /build/cli/openapi-yagen /usr/local/bin/openapi-yagen

WORKDIR /workspace
ENTRYPOINT ["openapi-yagen"]
CMD ["--help"]

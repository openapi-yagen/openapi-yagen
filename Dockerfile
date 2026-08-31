# syntax=docker/dockerfile:1
#
# Runtime image published to GitHub Container Registry as ghcr.io/openapi-yagen/openapi-yagen -
# unlike Dockerfile.musl (a build environment whose output is extracted onto the host), this image
# is meant to be run directly, e.g. on macOS where no native binary is published:
#
#   docker run --rm -v "$PWD":/workspace ghcr.io/openapi-yagen/openapi-yagen generate openapi.yaml -g builtin:kotlin_ktor_client -o out

FROM alpine:3.21 AS build

RUN set -x && \
    apk add --no-cache cmake py3-pip g++ make samurai git && \
    pip install conan --break-system-packages

RUN --mount=type=cache,target=/root/.conan2 \
    conan profile detect --force

COPY conanfile.txt /sources/

RUN --mount=type=cache,target=/root/.conan2 set -x && \
    mkdir -p /build && \
    cd /build && \
    conan install /sources -s compiler.cppstd=20 --output-folder=. --build=missing

COPY . /sources/

RUN --mount=type=cache,target=/root/.conan2 set -x && \
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

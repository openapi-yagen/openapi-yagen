#!/bin/bash
set -uo pipefail

# Integration tests for kotlin_ktor_client_generator / kotlin_ktor_server_generator: for each
# (spec, generator) combination below, run openapi-yagen to generate Kotlin source, then compile
# it with kotlinc against a resolved JVM classpath - failing if either step errors. Covers both
# a clean textbook spec (petstore) and a real-world one (the full, real GitHub Enterprise Server
# REST API spec, see ../resources/ghes-3.15.yaml) generated with `-v strict=false` - real-world
# specs routinely contain constructs a generator can't handle yet (see each generator's README),
# and permissive mode skips just those with a warning instead of failing the whole generation.
#
# Prerequisites:
#   - an openapi-yagen binary - set OPENAPI_YAGEN=/path/to/it, or it defaults to dist/openapi-yagen
#     at the repo root (build one first, e.g. ./build-musl.sh, or a local `cmake --build`)
#   - kotlinc on PATH (e.g. `sdk install kotlin` via https://sdkman.io)
#   - gradle on PATH, used once to resolve the JVM classpath (ktor-client-core, ktor-server-core,
#     kotlinx-serialization-json, kotlinx-datetime); needs network access the first time.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

OPENAPI_YAGEN="${OPENAPI_YAGEN:-$REPO_ROOT/dist/openapi-yagen}"

if [ ! -x "$OPENAPI_YAGEN" ]; then
    echo "error: openapi-yagen binary not found/executable at $OPENAPI_YAGEN" >&2
    echo "       build one first (e.g. ./build-musl.sh) or set OPENAPI_YAGEN=/path/to/binary" >&2
    exit 1
fi
if ! command -v kotlinc >/dev/null 2>&1; then
    echo "error: kotlinc not found on PATH (install e.g. via 'sdk install kotlin', https://sdkman.io)" >&2
    exit 1
fi
if ! command -v gradle >/dev/null 2>&1; then
    echo "error: gradle not found on PATH (needed once, to resolve the JVM test classpath)" >&2
    exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Resolving Kotlin/Ktor test classpath (first run needs network access)..."
CLASSPATH_FILE="$WORK_DIR/classpath.txt"
if ! (cd "$SCRIPT_DIR/classpath" && gradle printClasspath --console=plain -q) \
        | sed -n '/CLASSPATH_START/,/CLASSPATH_END/p' | sed '1d;$d' > "$CLASSPATH_FILE"; then
    echo "error: failed to resolve the Kotlin/Ktor classpath via gradle" >&2
    exit 1
fi
CP="$(cat "$CLASSPATH_FILE")"
if [ -z "$CP" ]; then
    echo "error: resolved classpath is empty" >&2
    exit 1
fi

FAILURES=0

run_case() {
    local label="$1" generator="$2" spec="$3" package="$4" strict="${5:-true}"
    local out_dir="$WORK_DIR/$label"

    echo
    echo "=== $label: $generator <- $(basename "$spec") (strict=$strict) ==="

    if ! "$OPENAPI_YAGEN" g -o "$out_dir" -g "$REPO_ROOT/generators/$generator/src" "$spec" \
            -v "packageName=$package" -v "strict=$strict" -c; then
        echo "FAIL ($label): generation failed" >&2
        FAILURES=$((FAILURES + 1))
        return
    fi

    local kt_files
    kt_files="$(find "$out_dir" -name '*.kt')"
    if [ -z "$kt_files" ]; then
        echo "FAIL ($label): no .kt files were generated" >&2
        FAILURES=$((FAILURES + 1))
        return
    fi

    if ! kotlinc -classpath "$CP" -d "$WORK_DIR/$label-classes" $kt_files > "$WORK_DIR/$label.log" 2>&1; then
        echo "FAIL ($label): kotlinc compilation failed" >&2
        cat "$WORK_DIR/$label.log" >&2
        FAILURES=$((FAILURES + 1))
        return
    fi

    echo "OK ($label): $(echo "$kt_files" | wc -l | tr -d ' ') file(s) generated and compiled cleanly"
}

run_case client-petstore kotlin_ktor_client_generator "$REPO_ROOT/test/resources/petstore.yaml"  com.example.petstore
run_case server-petstore kotlin_ktor_server_generator "$REPO_ROOT/test/resources/petstore.yaml"  com.example.petstore
run_case client-github   kotlin_ktor_client_generator "$REPO_ROOT/test/resources/ghes-3.15.yaml" com.example.github false
run_case server-github   kotlin_ktor_server_generator "$REPO_ROOT/test/resources/ghes-3.15.yaml" com.example.github false

echo
if [ "$FAILURES" -eq 0 ]; then
    echo "All Kotlin generator integration tests passed."
    exit 0
else
    echo "$FAILURES Kotlin generator integration test(s) failed."
    exit 1
fi

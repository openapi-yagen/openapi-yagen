#!/bin/bash
set -uo pipefail

# Runs every generator's own self-contained test suite (generators/*/test/), if present.
#
# Deliberately NOT a Gradle composite build / shared root settings.gradle.kts: each
# generators/*/test project must remain independently invocable (see generators/README.md) with
# zero awareness of being inside this particular repo checkout, so that copying a generator
# directory elsewhere (or dropping a foreign one in here) never requires touching a shared root
# build file, and one generator's test toolchain/versions can diverge freely from another's. This
# script is pure convenience glue for running all of them at once - not a build dependency of
# anything else in this repo.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILURES=0
FOUND=0

for build_file in "$REPO_ROOT"/generators/*/test/build.gradle.kts; do
    [ -e "$build_file" ] || continue
    FOUND=$((FOUND + 1))
    dir="$(dirname "$build_file")"
    name="$(basename "$(dirname "$dir")")"

    echo
    echo "=== $name ==="
    if ! (cd "$dir" && ./gradlew test); then
        echo "FAIL ($name)" >&2
        FAILURES=$((FAILURES + 1))
    fi
done

for pkg_file in "$REPO_ROOT"/generators/*/test/package.json; do
    [ -e "$pkg_file" ] || continue
    FOUND=$((FOUND + 1))
    dir="$(dirname "$pkg_file")"
    name="$(basename "$(dirname "$dir")")"

    echo
    echo "=== $name ==="
    if ! (cd "$dir" && npm install --no-audit --no-fund && npm test); then
        echo "FAIL ($name)" >&2
        FAILURES=$((FAILURES + 1))
    fi
done

for gemfile in "$REPO_ROOT"/generators/*/test/Gemfile; do
    [ -e "$gemfile" ] || continue
    FOUND=$((FOUND + 1))
    dir="$(dirname "$gemfile")"
    name="$(basename "$(dirname "$dir")")"

    echo
    echo "=== $name ==="
    if ! (cd "$dir" && bundle install && bundle exec rake test); then
        echo "FAIL ($name)" >&2
        FAILURES=$((FAILURES + 1))
    fi
done

for requirements in "$REPO_ROOT"/generators/*/test/requirements.txt; do
    [ -e "$requirements" ] || continue
    FOUND=$((FOUND + 1))
    dir="$(dirname "$requirements")"
    name="$(basename "$(dirname "$dir")")"

    echo
    echo "=== $name ==="
    if ! (cd "$dir" && python3 -m venv .venv && .venv/bin/pip install --quiet -r requirements.txt && .venv/bin/pytest); then
        echo "FAIL ($name)" >&2
        FAILURES=$((FAILURES + 1))
    fi
done

echo
if [ "$FOUND" -eq 0 ]; then
    echo "No generator test suites found (generators/*/test/build.gradle.kts, generators/*/test/package.json, generators/*/test/Gemfile, or generators/*/test/requirements.txt)."
    exit 0
elif [ "$FAILURES" -eq 0 ]; then
    echo "All $FOUND generator test suite(s) passed."
    exit 0
else
    echo "$FAILURES of $FOUND generator test suite(s) failed."
    exit 1
fi

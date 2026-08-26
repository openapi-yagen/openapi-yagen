#!/bin/bash
set -euo pipefail

BINARY="${OPENAPI_YAGEN:-../../../dist/openapi-yagen}"
cd "$(dirname "${BASH_SOURCE[0]}")"

"$BINARY" generate \
    -o generated \
    -g ../src \
    -c resources/kitchensink.yaml \
    -v "packageName=go_net_http_client_generator_test/generated"

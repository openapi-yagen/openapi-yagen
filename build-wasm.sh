#!/bin/bash

APP_NAME=openapi-yagen

IMAGE_NAME=${APP_NAME}-wasm

docker buildx build --progress plain --tag ${IMAGE_NAME} -f Dockerfile.wasm --load ${DOCKER_BUILDX_ARGS:-} .

id=$(docker create ${IMAGE_NAME})
mkdir -p dist/wasm
docker cp $id:/build/wasm/${APP_NAME}.js ./dist/wasm/
docker cp $id:/build/wasm/${APP_NAME}.wasm ./dist/wasm/
docker rm -v $id

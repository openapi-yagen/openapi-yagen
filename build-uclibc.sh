#!/bin/bash

APP_NAME=openapi-yagen-build

IMAGE_NAME=${APP_NAME}

docker buildx build --progress=plain --tag ${IMAGE_NAME} -f Dockerfile.uclibc --load ${DOCKER_BUILDX_ARGS:-} .

id=$(docker create ${IMAGE_NAME})
mkdir -p dist
docker cp $id:/build/cli/${APP_NAME} ./dist/
docker rm -v $id

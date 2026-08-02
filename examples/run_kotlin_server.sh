#!/bin/bash

openapi-yagen g -o out/kotlin-server -g kotlin_ktor_server_generator \
    -c ../test/resources/ghes-subset.yaml \
    -v "packageName=com.github.openapi"

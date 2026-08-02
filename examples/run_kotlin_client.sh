#!/bin/bash

openapi-yagen g -o out/kotlin-client -g kotlin_ktor_client_generator \
    -c ../test/resources/ghes-subset.yaml \
    -v "packageName=com.github.openapi"

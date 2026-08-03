#!/bin/bash

openapi-yagen g -o out/kotlin-server -g kotlin_ktor_server_generator/src \
    -c ../test/resources/petstore.yaml \
    -v "packageName=com.example.petstore"

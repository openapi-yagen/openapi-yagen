#!/bin/bash

openapi-yagen g -o out/kotlin-client -g kotlin_ktor_client_generator/src \
    -c ../test/resources/petstore.yaml \
    -v "packageName=com.example.petstore"

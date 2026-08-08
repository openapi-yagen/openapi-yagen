#!/bin/bash

openapi-yagen g -o out/ts-client -g typescript_fetch_client_generator/src \
    -c ../test/resources/petstore.yaml

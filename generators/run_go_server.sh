#!/bin/bash

openapi-yagen g -o out/go-server -g go_net_http_server_generator/src \
    -c ../test/resources/petstore.yaml \
    -v "packageName=github.com/example/petstore"

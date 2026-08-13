#!/bin/bash

openapi-yagen g -o out/ruby-client -g ruby_faraday_client_generator/src \
    -c ../test/resources/petstore.yaml \
    -v "moduleName=PetStore"

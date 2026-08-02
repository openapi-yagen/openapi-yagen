#!/bin/bash

openapi-yagen g -o out -g simple_cpp_models_generator \
    -c ../test/resources/petstore.yaml \
    -p "clang-format -i %file%" \
    -v "namespace=OpenAPI"
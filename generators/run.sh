#!/bin/bash

openapi-yagen g -o out -g sample_cpp_models_generator/src \
    -c ../test/resources/petstore.yaml \
    -p "clang-format -i %file%" \
    -v "namespace=OpenAPI"
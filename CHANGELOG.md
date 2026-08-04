# 0.9.0 (2026-08-04)

- Validate the OpenAPI spec against the official JSON Schema before generating, in the CLI and both Kotlin generators
- Add proper support for undiscriminated oneOf/anyOf schemas via a union model kind, fixing broken deserialization
- Add strict/permissive generation mode
- Add copyFile built-in
- Add a resolved OpenAPI schema graph exposed to JS, with kindOf/nameOf/constraintsOf/collectOperations built-ins and full $ref resolution
- Add identifier helper built-ins: case conversion (camelCase, snake_case, ...) and sanitizeIdentifier/isValidIdentifier
- Add Kotlin/Ktor client and server example generators
- Add log level option, add time to log messages, add time of generation
- Add dump debug helper (JS built-in and Inja template function)
- Add support for generator variables
- Add support for loading generators directly from GitHub/HTTP(S), with caching
- Add core templating capabilities: includes, calling JS-defined functions from templates, rendering to string, ES6 module imports, JS arrays in template context
- Add post processing of generated files
- Release binaries only on semver tags, document install one-liner
- Fix error when try to clean non existing directory
- Fix default values in generator options

# 0.0.1 (2024.10.12)

* Initial release

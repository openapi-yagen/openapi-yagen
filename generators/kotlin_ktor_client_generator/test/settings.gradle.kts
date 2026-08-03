// Deliberately its own root - no `include(...)`, no relation to any repo-level Gradle build.
// This project must stay independently invocable (`gradle test` from this directory) with no
// awareness of living inside the openapi-yagen repo, beyond the relative `../src` reference in
// build.gradle.kts to its own sibling generator directory - see generators/README.md.
rootProject.name = "kotlin-ktor-client-generator-tests"

// Self-contained runtime test suite for this generator (see generators/README.md): regenerates
// the Kotlin client from resources/kitchensink.yaml via the openapi-yagen CLI, compiles it
// together with the hand-written tests below, and runs them with `./gradlew test` (the committed
// Gradle wrapper means no separate Gradle install is needed, just a JDK) - no other Gradle module
// in this repo needs to know this project exists.

plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
}

repositories {
    mavenCentral()
}

// Keep in sync with test/kotlin_generators/classpath/build.gradle.kts and this generator's own
// README.md - the runtime artifacts below are additions this module actually needs to execute
// the generated code (ContentNegotiation, MockEngine), not compile-only as that module is.
val ktorVersion = "3.0.1"
val kotlinxSerializationVersion = "1.7.3"
val kotlinxDatetimeVersion = "0.6.1"

dependencies {
    implementation("io.ktor:ktor-client-core:$ktorVersion")
    implementation("io.ktor:ktor-client-content-negotiation:$ktorVersion")
    implementation("io.ktor:ktor-serialization-kotlinx-json:$ktorVersion")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:$kotlinxSerializationVersion")
    implementation("org.jetbrains.kotlinx:kotlinx-datetime:$kotlinxDatetimeVersion")

    testImplementation("io.ktor:ktor-client-mock:$ktorVersion")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit5:2.0.21")
    testImplementation(platform("org.junit:junit-bom:5.11.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin {
    jvmToolchain(17)
}

tasks.test {
    useJUnitPlatform()
}

// --- Generate step -----------------------------------------------------------------------
// Regenerates the Kotlin client from this project's own kitchen-sink spec, using this
// generator itself (../src, relative to this test/ dir), via the openapi-yagen CLI binary.
// OPENAPI_YAGEN follows the existing repo-wide convention (see test/kotlin_generators/run_tests.sh):
// an env var pointing at a prebuilt binary, defaulting to this checkout's dist/openapi-yagen so
// this still works out of the box inside the full openapi-yagen repo, but overridable to any
// binary (including one built from a different checkout) so this project has no hard dependency
// on living inside this specific repo layout.
val openApiYagenBin: String = providers.environmentVariable("OPENAPI_YAGEN")
    .orElse(providers.gradleProperty("openApiYagenBin"))
    .getOrElse("${projectDir}/../../../dist/openapi-yagen")

val generatedDir = layout.buildDirectory.dir("generated/kotlin")

val generateClient = tasks.register<Exec>("generateClient") {
    description = "Regenerates the Kotlin client from resources/kitchensink.yaml via openapi-yagen"
    inputs.file("resources/kitchensink.yaml")
    inputs.file("../src/generator.yml")
    inputs.dir("../src/templates")
    inputs.dir("../src/lib")
    inputs.file("../src/main.js")
    outputs.dir(generatedDir)

    doFirst {
        val bin = file(openApiYagenBin)
        if (!bin.canExecute()) {
            throw GradleException(
                "openapi-yagen binary not found/executable at $openApiYagenBin - build one first " +
                    "(e.g. ./build-musl.sh or cmake --build from the repo root) or set " +
                    "OPENAPI_YAGEN=/path/to/binary (env var) / -PopenApiYagenBin=/path/to/binary"
            )
        }
        delete(generatedDir)
    }

    commandLine(
        openApiYagenBin, "g",
        "-o", generatedDir.get().asFile.absolutePath,
        "-g", "${projectDir}/../src",
        "-c", "${projectDir}/resources/kitchensink.yaml",
        "-v", "packageName=com.example.kitchensink.client"
    )
}

sourceSets {
    main {
        kotlin.srcDir(generatedDir)
    }
}

tasks.compileKotlin { dependsOn(generateClient) }
tasks.compileTestKotlin { dependsOn(generateClient) }

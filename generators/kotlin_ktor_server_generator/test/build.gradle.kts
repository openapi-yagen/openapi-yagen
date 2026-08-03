// Self-contained runtime test suite for this generator (see generators/README.md): regenerates
// the Kotlin server routing from resources/kitchensink.yaml via the openapi-yagen CLI, compiles
// it together with the hand-written tests below, and runs them with `gradle test` - no other
// Gradle module in this repo needs to know this project exists.

plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
}

repositories {
    mavenCentral()
}

// Keep in sync with test/kotlin_generators/classpath/build.gradle.kts and this generator's own
// README.md - the runtime artifacts below are additions this module actually needs to execute
// the generated code (ContentNegotiation, StatusPages, the in-memory test server), not
// compile-only as that module is.
val ktorVersion = "3.0.1"
val kotlinxSerializationVersion = "1.7.3"
val kotlinxDatetimeVersion = "0.6.1"

dependencies {
    implementation("io.ktor:ktor-server-core:$ktorVersion")
    implementation("io.ktor:ktor-server-status-pages:$ktorVersion")
    implementation("io.ktor:ktor-server-content-negotiation:$ktorVersion")
    implementation("io.ktor:ktor-serialization-kotlinx-json:$ktorVersion")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:$kotlinxSerializationVersion")
    implementation("org.jetbrains.kotlinx:kotlinx-datetime:$kotlinxDatetimeVersion")

    testImplementation("io.ktor:ktor-server-test-host:$ktorVersion")
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
// Regenerates the Kotlin server routing from this project's own kitchen-sink spec, using this
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

val generateServer = tasks.register<Exec>("generateServer") {
    description = "Regenerates the Kotlin server routing from resources/kitchensink.yaml via openapi-yagen"
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
        "-v", "packageName=com.example.kitchensink.server"
    )
}

sourceSets {
    main {
        kotlin.srcDir(generatedDir)
    }
}

tasks.compileKotlin { dependsOn(generateServer) }
tasks.compileTestKotlin { dependsOn(generateServer) }

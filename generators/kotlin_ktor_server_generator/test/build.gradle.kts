// Self-contained runtime test suite for this generator (see generators/README.md): regenerates
// the Kotlin server routing from resources/kitchensink.yaml via the openapi-yagen CLI, compiles
// it together with the hand-written tests below, and runs them with `./gradlew test` (the
// committed Gradle wrapper means no separate Gradle install is needed, just a JDK) - no other
// Gradle module in this repo needs to know this project exists.
//
// Kotlin Multiplatform (jvm() + linuxX64()), not a plain kotlin("jvm") project: this generator's
// own README claims the generated server routing "works unchanged on every platform Ktor's server
// supports (JVM, Native)" - a claim nothing in this repo actually checked before, since only the
// JVM target ever got compiled. The generated sources live in commonMain so both targets compile
// them; the hand-written tests (ktor-server-test-host, JUnit5 - both JVM-only) stay in jvmTest,
// since a Kotlin/Native compile of the generated code (proving the *generator's own output* is
// portable) is the goal here, not standing up a whole second native test harness - see this
// project's README "Try it" / CI for how `compileKotlinLinuxX64` is checked separately from `test`.

import org.jetbrains.kotlin.gradle.tasks.KotlinCompilationTask

plugins {
    kotlin("multiplatform") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
}

repositories {
    mavenCentral()
}

// Keep these versions in sync with this generator's own README.md.
val ktorVersion = "3.0.1"
val kotlinxSerializationVersion = "1.7.3"
val kotlinxDatetimeVersion = "0.6.1"

// --- Generate step -----------------------------------------------------------------------
// Regenerates the Kotlin server routing from this project's own kitchen-sink spec, using this
// generator itself (../src, relative to this test/ dir), via the openapi-yagen CLI binary.
// OPENAPI_YAGEN is an env var pointing at a prebuilt binary, defaulting to this checkout's own
// dist/openapi-yagen (make sure that's up to date - see generators/README.md) so this still works
// out of the box inside the full openapi-yagen repo, but overridable to any binary (including one
// built from a different checkout) so this project has no hard dependency on living inside this
// specific repo layout.
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

kotlin {
    jvmToolchain(17)
    jvm()
    linuxX64()

    sourceSets {
        val commonMain by getting {
            kotlin.srcDir(generatedDir)
            dependencies {
                implementation("io.ktor:ktor-server-core:$ktorVersion")
                implementation("io.ktor:ktor-server-status-pages:$ktorVersion")
                implementation("io.ktor:ktor-server-content-negotiation:$ktorVersion")
                implementation("io.ktor:ktor-serialization-kotlinx-json:$ktorVersion")
                implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:$kotlinxSerializationVersion")
                implementation("org.jetbrains.kotlinx:kotlinx-datetime:$kotlinxDatetimeVersion")
            }
        }
        val jvmTest by getting {
            dependencies {
                implementation("io.ktor:ktor-server-test-host:$ktorVersion")
                implementation(kotlin("test"))
                implementation("org.jetbrains.kotlin:kotlin-test-junit5:2.0.21")
                implementation(platform("org.junit:junit-bom:5.11.3"))
                implementation("org.junit.jupiter:junit-jupiter")
                runtimeOnly("org.junit.platform:junit-platform-launcher")
            }
        }
    }
}

tasks.withType<Test> {
    useJUnitPlatform()
}

// KMP has no top-level `test` task (only per-target ones: jvmTest, linuxX64Test, ...) - alias it
// to jvmTest so `./gradlew test` (this project's documented entry point, and what CI runs) keeps
// working unchanged. linuxX64 is checked separately via `compileKotlinLinuxX64` (see this
// project's README/CI) - compiling the generated code under Kotlin/Native, not running tests
// there (no native test framework wired up; "compile is the floor" - see AGENTS.md/backlog).
tasks.register("test") {
    dependsOn("jvmTest")
}

// commonMain's kotlin.srcDir points at generatedDir, so every target's compile (jvm, linuxX64)
// needs it regenerated first - simplest to hook every Kotlin compile task uniformly rather than
// chase KMP's per-target task names (compileKotlinJvm, compileKotlinLinuxX64, ...) by hand.
tasks.withType<KotlinCompilationTask<*>>().configureEach {
    dependsOn(generateServer)
}

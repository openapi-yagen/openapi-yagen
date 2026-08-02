// Not a real module - just declares the runtime dependencies the generated Kotlin/Ktor code
// needs, so `./run_tests.sh` can resolve a JVM classpath for `kotlinc` via the `printClasspath`
// task below. Keep these versions in sync with what each generator's README documents.
plugins {
    kotlin("jvm") version "2.0.21"
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("io.ktor:ktor-client-core-jvm:3.0.1")
    implementation("io.ktor:ktor-server-core-jvm:3.0.1")
    implementation("io.ktor:ktor-server-status-pages-jvm:3.0.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json-jvm:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-datetime-jvm:0.6.1")
}

tasks.register("printClasspath") {
    doLast {
        println("CLASSPATH_START")
        println(sourceSets["main"].runtimeClasspath.files.joinToString(":"))
        println("CLASSPATH_END")
    }
}

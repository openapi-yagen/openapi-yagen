package com.example.kitchensink.client

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// Generation-only (not compiled) coverage of the dateTimeType variable's non-default values -
// see lib/types.js's configureDateTimeType. Shells out to the CLI directly against
// kitchensink.yaml, same pattern as GenerationErrorsTest, and asserts on the generated Pet.kt
// source rather than compiling it (a second compiled variant isn't worth the Gradle complexity -
// see the plan this test was added from).
class DateTimeTypeTest {
    private val bin = System.getProperty("openApiYagenBin")
    private val generatorSrc = System.getProperty("generatorSrcDir")
    private val spec = File(System.getProperty("testResourcesDir"), "kitchensink.yaml").absolutePath

    private fun generate(outDir: File, vararg extraArgs: String): Pair<Int, String> {
        val command = mutableListOf(
            bin, "g", "-o", outDir.absolutePath, "-g", generatorSrc, "-c", spec,
            "-v", "packageName=com.example.datetimetype"
        )
        command.addAll(extraArgs)
        val process = ProcessBuilder(command).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().readText()
        val exitCode = process.waitFor()
        return exitCode to output
    }

    @Test
    fun `an unrecognized dateTimeType value fails generation with the allowed values listed`() {
        val outDir = Files.createTempDirectory("kotlin-datetimetype-invalid-").toFile()
        try {
            val (exitCode, output) = generate(outDir, "-v", "dateTimeType=bogus")
            assertTrue(exitCode != 0, "expected generation to fail: $output")
            assertTrue(output.contains("bogus"), output)
            assertTrue(output.contains("kotlinx.datetime.Instant"), output)
            assertTrue(output.contains("kotlin.time.Instant"), output)
        } finally {
            outDir.deleteRecursively()
        }
    }

    @Test
    fun `dateTimeType=kotlin_time_Instant generates the stdlib type with no serializer annotation`() {
        val outDir = Files.createTempDirectory("kotlin-datetimetype-stdlib-").toFile()
        try {
            val (exitCode, output) = generate(outDir, "-v", "dateTimeType=kotlin.time.Instant")
            assertTrue(exitCode == 0, "expected generation to succeed: $output")
            val petSource = File(outDir, "models/Pet.kt").readText()
            assertTrue(petSource.contains("val createdAt: kotlin.time.Instant"), petSource)
            // kotlin.time.Instant has built-in kotlinx.serialization support - no
            // @Serializable(with = ...) needed (and InstantIso8601Serializer doesn't even exist
            // for it in kotlinx-datetime 0.7.x, only for the legacy kotlinx.datetime.Instant
            // typealias - see lib/types.js's DATE_TIME_TYPES).
            assertFalse(petSource.contains("InstantIso8601Serializer"), petSource)
        } finally {
            outDir.deleteRecursively()
        }
    }

    @Test
    fun `dateTimeType=String generates a plain String with no serializer annotation`() {
        val outDir = Files.createTempDirectory("kotlin-datetimetype-string-").toFile()
        try {
            val (exitCode, output) = generate(outDir, "-v", "dateTimeType=String")
            assertTrue(exitCode == 0, "expected generation to succeed: $output")
            val petSource = File(outDir, "models/Pet.kt").readText()
            assertTrue(petSource.contains("val createdAt: String"), petSource)
            assertFalse(petSource.contains("InstantIso8601Serializer"), petSource)
        } finally {
            outDir.deleteRecursively()
        }
    }
}

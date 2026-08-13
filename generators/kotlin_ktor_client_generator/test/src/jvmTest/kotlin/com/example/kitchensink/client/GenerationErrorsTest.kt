package com.example.kitchensink.client

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// Shells out to the openapi-yagen binary directly (not through Gradle's own generateClient task,
// which regenerates the *happy-path* kitchensink.yaml fixture under default strict=true) to prove
// an unsupported request-body content-type actually fails generation loudly instead of silently
// dropping the body - see resources/unsupported_content_type.yaml and lib/operations.js's
// pickBodyContent/buildRequestBody. Paths come from system properties set by build.gradle.kts's
// own tasks.withType<Test> block, not guessed from the JVM test process's working directory.
class GenerationErrorsTest {
    private val bin = System.getProperty("openApiYagenBin")
    private val generatorSrc = System.getProperty("generatorSrcDir")
    private val spec = File(System.getProperty("testResourcesDir"), "unsupported_content_type.yaml").absolutePath

    private fun generate(outDir: File, vararg extraArgs: String): Pair<Int, String> {
        val command = mutableListOf(
            bin, "g", "-o", outDir.absolutePath, "-g", generatorSrc, "-c", spec,
            "-v", "packageName=com.example.unsupported"
        )
        command.addAll(extraArgs)
        val process = ProcessBuilder(command).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().readText()
        val exitCode = process.waitFor()
        return exitCode to output
    }

    @Test
    fun `an unsupported request body content-type aborts generation by default (strict=true)`() {
        val outDir = Files.createTempDirectory("kotlin-unsupported-strict-").toFile()
        try {
            val (exitCode, output) = generate(outDir)
            assertTrue(exitCode != 0, "expected generation to fail in strict mode (default): $output")
            assertTrue(output.contains("text/plain"), output)
        } finally {
            outDir.deleteRecursively()
        }
    }

    @Test
    fun `an unsupported request body content-type is skipped with a warning under strict=false`() {
        val outDir = Files.createTempDirectory("kotlin-unsupported-permissive-").toFile()
        try {
            val (exitCode, output) = generate(outDir, "-v", "strict=false")
            assertTrue(exitCode == 0, "expected generation to succeed under -v strict=false: $output")
            assertTrue(output.contains("WARNING"), output)
            assertTrue(output.contains("text/plain"), output)
            assertFalse(File(outDir, "apis/NotesApi.kt").exists())
        } finally {
            outDir.deleteRecursively()
        }
    }
}

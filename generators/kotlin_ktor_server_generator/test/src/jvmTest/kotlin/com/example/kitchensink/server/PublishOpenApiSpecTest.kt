package com.example.kitchensink.server

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// Generation-only (not compiled) coverage of the publishOpenApiSpec/openApiSpecPath variables -
// see main.js. build.gradle.kts's own generateServer task always passes publishOpenApiSpec=true
// (see OpenApiSpecRouteTest for the compiled/runtime coverage of that), so this shells out to the
// CLI directly, same pattern as GenerateModeTest, to also cover the opt-in default being off.
class PublishOpenApiSpecTest {
    private val bin = System.getProperty("openApiYagenBin")
    private val generatorSrc = System.getProperty("generatorSrcDir")
    private val spec = File(System.getProperty("testResourcesDir"), "kitchensink.yaml").absolutePath

    private fun generate(outDir: File, vararg extraArgs: String): Pair<Int, String> {
        val command = mutableListOf(
            bin, "g", "-o", outDir.absolutePath, "-g", generatorSrc, "-c", spec,
            "-v", "packageName=com.example.publishopenapispec"
        )
        command.addAll(extraArgs)
        val process = ProcessBuilder(command).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().readText()
        val exitCode = process.waitFor()
        return exitCode to output
    }

    @Test
    fun `publishOpenApiSpec is off by default`() {
        val outDir = Files.createTempDirectory("kotlin-server-publishspec-default-").toFile()
        try {
            val (exitCode, output) = generate(outDir)
            assertTrue(exitCode == 0, "expected generation to succeed: $output")
            assertFalse(File(outDir, "OpenApiSpecRoute.kt").exists())
        } finally {
            outDir.deleteRecursively()
        }
    }

    @Test
    fun `publishOpenApiSpec=true embeds the effective spec as a string constant`() {
        val outDir = Files.createTempDirectory("kotlin-server-publishspec-on-").toFile()
        try {
            val (exitCode, output) = generate(outDir, "-v", "publishOpenApiSpec=true")
            assertTrue(exitCode == 0, "expected generation to succeed: $output")
            val source = File(outDir, "OpenApiSpecRoute.kt").readText()
            assertTrue(source.contains("class OpenApiSpecRoute"), source)
            assertTrue(source.contains("\"/openapi.json\""), source)
            assertTrue(source.contains("\"openapi\""), source)
        } finally {
            outDir.deleteRecursively()
        }
    }

    @Test
    fun `openApiSpecPath overrides the default route path`() {
        val outDir = Files.createTempDirectory("kotlin-server-publishspec-path-").toFile()
        try {
            val (exitCode, output) = generate(outDir, "-v", "publishOpenApiSpec=true", "-v", "openApiSpecPath=/spec")
            assertTrue(exitCode == 0, "expected generation to succeed: $output")
            val source = File(outDir, "OpenApiSpecRoute.kt").readText()
            assertTrue(source.contains("\"/spec\""), source)
        } finally {
            outDir.deleteRecursively()
        }
    }
}

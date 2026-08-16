package com.example.kitchensink.server

import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

// Generation-only (not compiled) coverage of the generate variable - see main.js's GENERATE_MODES.
// Shells out to the CLI directly against kitchensink.yaml, same pattern as DateTimeTypeTest, and
// asserts on which files exist rather than compiling a second variant (see the plan this test was
// added from).
class GenerateModeTest {
    private val bin = System.getProperty("openApiYagenBin")
    private val generatorSrc = System.getProperty("generatorSrcDir")
    private val spec = File(System.getProperty("testResourcesDir"), "kitchensink.yaml").absolutePath

    private fun generate(outDir: File, vararg extraArgs: String): Pair<Int, String> {
        val command = mutableListOf(
            bin, "g", "-o", outDir.absolutePath, "-g", generatorSrc, "-c", spec,
            "-v", "packageName=com.example.generatemode"
        )
        command.addAll(extraArgs)
        val process = ProcessBuilder(command).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().readText()
        val exitCode = process.waitFor()
        return exitCode to output
    }

    @Test
    fun `an unrecognized generate value fails generation with the allowed values listed`() {
        val outDir = Files.createTempDirectory("kotlin-server-generatemode-invalid-").toFile()
        try {
            val (exitCode, output) = generate(outDir, "-v", "generate=bogus")
            assertTrue(exitCode != 0, "expected generation to fail: $output")
            assertTrue(output.contains("bogus"), output)
            assertTrue(output.contains("all"), output)
            assertTrue(output.contains("models"), output)
            assertTrue(output.contains("api"), output)
        } finally {
            outDir.deleteRecursively()
        }
    }

    @Test
    fun `generate=api skips models but still generates routes and validate() extensions`() {
        val outDir = Files.createTempDirectory("kotlin-server-generatemode-api-").toFile()
        try {
            val (exitCode, output) = generate(outDir, "-v", "generate=api")
            assertTrue(exitCode == 0, "expected generation to succeed: $output")
            assertFalse(File(outDir, "models").exists(), "models/ should not exist")
            assertTrue(File(outDir, "Validation.kt").exists())
            assertTrue(File(outDir, "apis/PetsApiRoutes.kt").exists())
            val modelValidation = File(outDir, "ModelValidation.kt")
            assertTrue(modelValidation.exists())
            assertTrue(modelValidation.readText().contains("fun Pet.validate()"), modelValidation.readText())
        } finally {
            outDir.deleteRecursively()
        }
    }

    @Test
    fun `generate=models generates only the models, with no validate() extension on the model itself`() {
        val outDir = Files.createTempDirectory("kotlin-server-generatemode-models-").toFile()
        try {
            val (exitCode, output) = generate(outDir, "-v", "generate=models")
            assertTrue(exitCode == 0, "expected generation to succeed: $output")
            val petSource = File(outDir, "models/Pet.kt")
            assertTrue(petSource.exists())
            assertFalse(petSource.readText().contains("validate()"), petSource.readText())
            assertFalse(File(outDir, "Validation.kt").exists())
            assertFalse(File(outDir, "ModelValidation.kt").exists())
            assertFalse(File(outDir, "apis").exists(), "apis/ should not exist")
        } finally {
            outDir.deleteRecursively()
        }
    }

    @Test
    fun `generate=all (default) puts validate() in ModelValidation_kt, not on the model itself`() {
        val outDir = Files.createTempDirectory("kotlin-server-generatemode-all-").toFile()
        try {
            val (exitCode, output) = generate(outDir)
            assertTrue(exitCode == 0, "expected generation to succeed: $output")
            val petSource = File(outDir, "models/Pet.kt").readText()
            assertFalse(petSource.contains("validate()"), petSource)
            val modelValidation = File(outDir, "ModelValidation.kt").readText()
            assertTrue(modelValidation.contains("fun Pet.validate()"), modelValidation)
        } finally {
            outDir.deleteRecursively()
        }
    }
}

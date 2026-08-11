package com.example.kitchensink.client

import java.io.File
import kotlin.test.Test
import kotlin.test.assertTrue

// Asserts that OpenAPI `description` (schema/model, property, parameter, operation) and the
// document's `tags[].description` all reach the generated source as KDoc comments - not just
// that the generated code compiles/runs (the other test files in this suite), but that this
// specific generator promise (see README.md's "oneOf/anyOf support"/"Known limitations") actually
// holds. Reads the raw generated file text rather than reflection, since KDoc comments aren't
// part of the compiled class's runtime shape at all.
class GeneratedDocCommentsTest {
    private val generatedDir = File("build/generated/kotlin")

    @Test
    fun `model and property descriptions land as KDoc`() {
        val pet = File(generatedDir, "models/Pet.kt").readText()
        assertTrue(pet.contains("/** A pet available in the store. */"), "missing model-level KDoc:\n$pet")
        assertTrue(pet.contains("/** The pet's display name. */"), "missing property-level KDoc:\n$pet")

        val petStatus = File(generatedDir, "models/PetStatus.kt").readText()
        assertTrue(petStatus.contains("/** A pet's availability status. */"), "missing enum KDoc:\n$petStatus")

        val pets = File(generatedDir, "models/Pets.kt").readText()
        assertTrue(pets.contains("/** A page of pets. */"), "missing typealias KDoc:\n$pets")
    }

    @Test
    fun `operation summary, description, and param docs land as KDoc, and the class itself gets the tag's description`() {
        val petsApi = File(generatedDir, "apis/PetsApi.kt").readText()
        assertTrue(
            petsApi.contains("/** Operations for browsing and managing pets"),
            "missing class-level (tag) KDoc:\n$petsApi"
        )
        assertTrue(petsApi.contains("* List all pets."), "missing operation summary:\n$petsApi")
        assertTrue(
            petsApi.contains("* Returns a page of pets, optionally filtered by tag."),
            "missing operation description:\n$petsApi"
        )
        assertTrue(petsApi.contains("* @param limit Maximum number of pets to return."), "missing @param limit:\n$petsApi")
        assertTrue(petsApi.contains("* @param tag Only return pets with this tag."), "missing @param tag:\n$petsApi")
    }

    @Test
    fun `an operation with no summary or description gets no doc comment, not an empty one`() {
        val lines = File(generatedDir, "apis/PetsApi.kt").readLines()
        // createPet has no summary/description/documented params in the fixture - the KDoc
        // machinery must degrade to nothing, not emit a stray "/**" with no content. Check the
        // immediately preceding non-blank line isn't part of a doc comment block.
        val fnIndex = lines.indexOfFirst { it.contains("suspend fun createPet") }
        assertTrue(fnIndex > 0, "createPet function not found")
        val precedingLine = lines.subList(0, fnIndex).last { it.isNotBlank() }
        assertTrue(!precedingLine.trimStart().let { it.startsWith("*") || it.startsWith("/**") }, "unexpected doc comment before createPet: \"$precedingLine\"")
    }
}

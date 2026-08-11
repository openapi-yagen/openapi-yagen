package com.example.kitchensink.server

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
    fun `operation summary, description, and param docs land as KDoc on the handler interface, and the class itself gets the tag's description`() {
        val handler = File(generatedDir, "apis/PetsApiHandler.kt").readText()
        assertTrue(
            handler.contains("/** Operations for browsing and managing pets"),
            "missing interface-level (tag) KDoc:\n$handler"
        )
        assertTrue(handler.contains("* List all pets."), "missing operation summary:\n$handler")
        assertTrue(
            handler.contains("* Returns a page of pets, optionally filtered by tag."),
            "missing operation description:\n$handler"
        )
        assertTrue(handler.contains("* @param limit Maximum number of pets to return."), "missing @param limit:\n$handler")
        assertTrue(handler.contains("* @param tag Only return pets with this tag."), "missing @param tag:\n$handler")
    }

    @Test
    fun `operation docs and the tag description also land on the routes class`() {
        val routes = File(generatedDir, "apis/PetsApiRoutes.kt").readText()
        assertTrue(
            routes.contains("/** Operations for browsing and managing pets"),
            "missing routes class-level (tag) KDoc:\n$routes"
        )
        assertTrue(routes.contains("* List all pets."), "missing operation summary on routes:\n$routes")
    }
}

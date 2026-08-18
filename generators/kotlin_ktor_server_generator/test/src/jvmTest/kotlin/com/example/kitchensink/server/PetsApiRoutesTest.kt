package com.example.kitchensink.server

import com.example.kitchensink.server.models.Pet
import com.example.kitchensink.server.models.Pets
import com.example.kitchensink.server.support.installKitchenSinkApp
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.datetime.Instant
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Runs the generated PetsApiRoutes against a real (in-memory, no socket) Ktor server, wired to
// the FakePetsApiHandler in fakes/ - proves every generated route parses/validates its
// parameters and body correctly, both on the happy path and on each documented error path.
class PetsApiRoutesTest {
    @Test
    fun `listPets returns all pets when no filters given`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/pets")
        assertEquals(HttpStatusCode.OK, response.status)
        val pets = Json.decodeFromString<Pets>(response.bodyAsText())
        assertEquals(1, pets.size)
        assertEquals("Rex", pets.first().name)
    }

    @Test
    fun `listPets respects the tag filter`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/pets?tag=cat")
        assertEquals(HttpStatusCode.OK, response.status)
        val pets = Json.decodeFromString<Pets>(response.bodyAsText())
        assertTrue(pets.isEmpty())
    }

    // Validation.kt wraps the NumberFormatException from a non-numeric value as a
    // BadRequestException itself - no separate StatusPages entry needed (see support/TestApp.kt).
    @Test
    fun `listPets with a non-numeric limit returns 400`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/pets?limit=notanumber")
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `listPets with limit over its maximum returns 400`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/pets?limit=101")
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `createPet with a valid body returns 201`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets") {
            contentType(ContentType.Application.Json)
            setBody("""{"name":"Fido","tag":"dog"}""")
        }
        assertEquals(HttpStatusCode.Created, response.status)
        val pet = Json.decodeFromString<Pet>(response.bodyAsText())
        assertEquals("Fido", pet.name)
    }

    @Test
    fun `createPet with a name shorter than minLength returns 400`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets") {
            contentType(ContentType.Application.Json)
            setBody("""{"name":""}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `createPet with a name longer than maxLength returns 400`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets") {
            contentType(ContentType.Application.Json)
            setBody("""{"name":"${"x".repeat(51)}"}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    // Recursive validate(): an array-of-primitive-with-constraints property (nicknames: string
    // items with maxLength) gets each element checked, not just the model's own direct fields.
    @Test
    fun `createPet with a nickname longer than its item maxLength returns 400`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets") {
            contentType(ContentType.Application.Json)
            setBody("""{"name":"Fido","nicknames":["${"x".repeat(11)}"]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `createPet with all nicknames within the item maxLength returns 201`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets") {
            contentType(ContentType.Application.Json)
            setBody("""{"name":"Fido","nicknames":["Fi","Do"]}""")
        }
        assertEquals(HttpStatusCode.Created, response.status)
    }

    // Recursive validate(): an array-of-object property (ratings: Rating items) calls each
    // element's own generated validate() - Rating's score is constrained to 1..5.
    @Test
    fun `createPet with a nested rating outside its min-max range returns 400`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets") {
            contentType(ContentType.Application.Json)
            setBody("""{"name":"Fido","ratings":[{"score":9,"label":"ok"}]}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `createPet with a valid nested rating returns 201`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets") {
            contentType(ContentType.Application.Json)
            setBody("""{"name":"Fido","ratings":[{"score":4,"label":"good"}]}""")
        }
        assertEquals(HttpStatusCode.Created, response.status)
    }

    @Test
    fun `getPetById for a known id returns 200`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/pets/1")
        assertEquals(HttpStatusCode.OK, response.status)
        val pet = Json.decodeFromString<Pet>(response.bodyAsText())
        assertEquals(1, pet.id)
        assertEquals(Instant.parse("2024-01-15T10:30:00Z"), pet.createdAt)
    }

    // Not-found is not a generator feature (see support/TestApp.kt) - this proves the pattern an
    // integrator is expected to use actually works end to end.
    @Test
    fun `getPetById for an unknown id returns 404`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/pets/does-not-exist")
        assertEquals(HttpStatusCode.NotFound, response.status)
    }

    @Test
    fun `deletePet for a known id returns 204`() = testApplication {
        installKitchenSinkApp()
        val response = client.delete("/pets/1") {
            header("Authorization", "Bearer secret-token")
        }
        assertEquals(HttpStatusCode.NoContent, response.status)
    }

    @Test
    fun `deletePet for an unknown id returns 404`() = testApplication {
        installKitchenSinkApp()
        val response = client.delete("/pets/does-not-exist") {
            header("Authorization", "Bearer secret-token")
        }
        assertEquals(HttpStatusCode.NotFound, response.status)
    }

    // Wired from the spec's `security: [{bearerAuth: []}]` on this operation (see
    // components.securitySchemes.bearerAuth in kitchensink.yaml) - proves the generated handler
    // actually requires the token, not just accepts it when present.
    @Test
    fun `deletePet without an Authorization header returns 400`() = testApplication {
        installKitchenSinkApp()
        val response = client.delete("/pets/1")
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `ratePet without the required X-Request-Id header returns 400`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets/1/ratings") {
            contentType(ContentType.Application.Json)
            setBody("""{"score":3,"label":"ok"}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    // Wired from the spec's `security: [{apiKeyAuth: []}]` on this operation (see
    // components.securitySchemes.apiKeyAuth, an apiKey scheme in the X-Api-Key header).
    @Test
    fun `ratePet without the X-Api-Key header returns 400`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets/1/ratings") {
            contentType(ContentType.Application.Json)
            header("X-Request-Id", "req-1")
            setBody("""{"score":3,"label":"ok"}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `ratePet with a score outside its min-max range returns 400`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets/1/ratings") {
            contentType(ContentType.Application.Json)
            header("X-Request-Id", "req-1")
            header("X-Api-Key", "test-key")
            setBody("""{"score":9,"label":"ok"}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `ratePet with a label violating the pattern returns 400`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets/1/ratings") {
            contentType(ContentType.Application.Json)
            header("X-Request-Id", "req-1")
            header("X-Api-Key", "test-key")
            setBody("""{"score":3,"label":"NOT-lowercase"}""")
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `ratePet with a valid request and header returns 204`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets/1/ratings") {
            contentType(ContentType.Application.Json)
            header("X-Request-Id", "req-1")
            header("X-Api-Key", "test-key")
            setBody("""{"score":4,"label":"good"}""")
        }
        assertEquals(HttpStatusCode.NoContent, response.status)
    }
}

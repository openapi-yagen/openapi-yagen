package com.example.kitchensink.client

import com.example.kitchensink.client.support.buildTestClient
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse

// Runs the generated PetsApi against a MockEngine - no real server involved - asserting both
// what the client sends (path/method/query/header/body) and how it handles responses, including
// the documented v1 limitation that it never inspects the HTTP status code (see the negative
// tests at the bottom).
class PetsApiTest {
    @Test
    fun `getPetById sends the correct path and method, and parses the response`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond(
                content = """{"id":1,"name":"Rex","tag":"dog","createdAt":"2024-01-15T10:30:00Z"}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = PetsApi(client, baseUrl = "https://example.test")

        val pet = api.getPetById("1")

        assertEquals("/pets/1", captured!!.url.encodedPath)
        assertEquals(HttpMethod.Get, captured!!.method)
        assertEquals("Rex", pet.name)
        assertEquals(Instant.parse("2024-01-15T10:30:00Z"), pet.createdAt)
    }

    @Test
    fun `listPets omits absent optional query params`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond("[]", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val api = PetsApi(client, "https://example.test")

        api.listPets(limit = null, tag = null)

        assertFalse(captured!!.url.parameters.contains("limit"))
        assertFalse(captured!!.url.parameters.contains("tag"))
    }

    @Test
    fun `listPets includes present optional query params`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond("[]", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val api = PetsApi(client, "https://example.test")

        api.listPets(limit = 5, tag = "dog")

        assertEquals("5", captured!!.url.parameters["limit"])
        assertEquals("dog", captured!!.url.parameters["tag"])
    }

    @Test
    fun `createPet sends a JSON body matching NewPet's shape`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond(
                content = """{"id":1,"name":"Fido","tag":"dog"}""",
                status = HttpStatusCode.Created,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = PetsApi(client, "https://example.test")

        api.createPet(NewPet(name = "Fido", tag = "dog", notes = null, status = null))

        assertEquals(HttpMethod.Post, captured!!.method)
        val sentJson = Json.parseToJsonElement((captured!!.body as TextContent).text).jsonObject
        assertEquals("Fido", sentJson.getValue("name").jsonPrimitive.content)
        assertEquals("dog", sentJson.getValue("tag").jsonPrimitive.content)
    }

    @Test
    fun `ratePet sends the required X-Request-Id header`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond("", HttpStatusCode.NoContent)
        }
        val api = PetsApi(client, "https://example.test")

        api.ratePet(petId = "1", xRequestId = "req-123", body = Rating(score = 4, label = "good"))

        assertEquals("req-123", captured!!.headers["X-Request-Id"])
    }

    // --- Negative cases: accurate to the generated code, not aspirational -----------------
    //
    // api_client.kt.j2 never checks response.status - it unconditionally calls response.body()
    // (or, for void operations, discards the response entirely). Ktor's HttpClientConfig.
    // expectSuccess defaults to false in Ktor 3.x, and the generator never sets it. So a non-2xx
    // status by itself never throws; these tests document precisely what does (and doesn't)
    // happen instead.

    @Test
    fun `getPetById against a mocked error response fails on body shape mismatch, not on status`() = runTest {
        // The mocked 404 body is shaped like Error (code/message), not Pet (id/name required) -
        // decoding it as Pet throws because the JSON shape doesn't match, not because of the
        // 404 status, which is never inspected.
        val client = buildTestClient { _ ->
            respond(
                content = """{"code":404,"message":"not found"}""",
                status = HttpStatusCode.NotFound,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = PetsApi(client, "https://example.test")

        assertFailsWith<Exception> {
            api.getPetById("missing")
        }
    }

    @Test
    fun `deletePet against a mocked error response completes without throwing`() = runTest {
        // deletePet is void-returning - the generated code never calls response.body() at all,
        // so status and body are both discarded entirely; this must NOT throw.
        val client = buildTestClient { _ -> respond("", HttpStatusCode.NotFound) }
        val api = PetsApi(client, "https://example.test")

        api.deletePet("missing")
    }

    @Test
    fun `getPetById against a mocked error response with a Pet-shaped body returns it as if successful`() = runTest {
        // The sharpest edge of the same limitation: since status is never checked, a non-2xx
        // response whose body happens to satisfy the expected model deserializes successfully
        // and is returned as if the call had succeeded.
        val client = buildTestClient { _ ->
            respond(
                content = """{"id":1,"name":"Rex"}""",
                status = HttpStatusCode.NotFound,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = PetsApi(client, "https://example.test")

        val pet = api.getPetById("missing")
        assertEquals("Rex", pet.name)
    }
}

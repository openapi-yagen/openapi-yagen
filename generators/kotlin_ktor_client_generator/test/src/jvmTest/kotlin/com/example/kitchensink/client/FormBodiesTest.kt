package com.example.kitchensink.client

import com.example.kitchensink.client.support.buildTestClient
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.parseQueryString
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Exercises the four non-default-JSON request-body encodings this generator supports (see
// lib/operations.js's pickBodyContent/buildRequestBody and api_client.kt.j2's FormDataContent/
// MultiPartFormDataContent/ContentType.parse branches) against a MockEngine - same style as
// PetsApiTest.
class FormBodiesTest {
    @Test
    fun `subscribeToPet sends the body as application_x-www-form-urlencoded`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond("", HttpStatusCode.NoContent)
        }
        val api = PetsApi(client, "https://example.test")

        api.subscribeToPet(petId = "1", body = PetSubscription(email = "me@example.com", notify = true))

        assertEquals(HttpMethod.Post, captured!!.method)
        val body = captured!!.body as OutgoingContent.ByteArrayContent
        assertTrue(body.contentType?.toString()?.startsWith("application/x-www-form-urlencoded") == true)
        val params = parseQueryString(String(body.bytes()))
        assertEquals("me@example.com", params["email"])
        assertEquals("true", params["notify"])
    }

    @Test
    fun `uploadPetPhoto sends the body as multipart_form-data`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond("", HttpStatusCode.NoContent)
        }
        val api = PetsApi(client, "https://example.test")

        api.uploadPetPhoto(petId = "1", body = PetPhotoUpload(caption = "cute", photo = "raw-bytes"))

        assertEquals(HttpMethod.Post, captured!!.method)
        // MultiPartFormDataContent is streamed (WriteChannelContent), not a simple byte buffer -
        // asserting on the auto-generated boundary'd Content-Type is enough to prove the generated
        // code picked the multipart builder and didn't crash building/sending it.
        assertTrue(captured!!.body.contentType?.toString()?.startsWith("multipart/form-data") == true)
    }

    @Test
    fun `setPetNotes sends and parses a text_plain body as a plain String`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond("echo: " + String((request.body as OutgoingContent.ByteArrayContent).bytes()), HttpStatusCode.OK)
        }
        val api = PetsApi(client, "https://example.test")

        val result = api.setPetNotes(petId = "1", body = "likes belly rubs")

        assertEquals(HttpMethod.Post, captured!!.method)
        // Ktor's setBody(String) wraps a raw string into TextContent, which appends "; charset=
        // UTF-8" to whatever Content-Type was set for a text/* type - not something the generated
        // code controls, so this only checks the media type prefix, same as the multipart/
        // urlencoded assertions above.
        assertTrue(captured!!.body.contentType?.toString()?.startsWith("text/plain") == true)
        assertEquals("likes belly rubs", String((captured!!.body as OutgoingContent.ByteArrayContent).bytes()))
        assertEquals("echo: likes belly rubs", result)
    }

    @Test
    fun `uploadPetAvatar sends and parses an application_octet-stream body as raw bytes`() = runTest {
        val bytes = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47)
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond(bytes, HttpStatusCode.OK)
        }
        val api = PetsApi(client, "https://example.test")

        val result = api.uploadPetAvatar(petId = "1", body = bytes)

        assertEquals(HttpMethod.Put, captured!!.method)
        assertEquals("application/octet-stream", captured!!.body.contentType?.toString())
        assertContentEquals(bytes, (captured!!.body as OutgoingContent.ByteArrayContent).bytes())
        assertContentEquals(bytes, result)
    }
}

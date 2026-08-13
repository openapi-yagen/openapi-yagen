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
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Exercises the two non-JSON request-body encodings this generator supports (see
// lib/operations.js's pickBodyContent/buildRequestBody and api_client.kt.j2's FormDataContent/
// MultiPartFormDataContent branches) against a MockEngine - same style as PetsApiTest.
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
}

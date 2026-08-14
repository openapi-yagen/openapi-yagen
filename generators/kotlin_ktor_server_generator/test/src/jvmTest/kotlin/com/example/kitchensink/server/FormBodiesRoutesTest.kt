package com.example.kitchensink.server

import com.example.kitchensink.server.fakes.FakePetsApiHandler
import com.example.kitchensink.server.support.installKitchenSinkApp
import io.ktor.client.request.forms.FormDataContent
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsBytes
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.Parameters
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Exercises the four non-default-JSON request-body encodings this generator supports (see
// lib/operations.js's pickBodyContent/buildRequestBody and api_routes.kt.j2's
// receiveParameters()/receiveMultipart()/receive<String|ByteArray>() branches) against a real
// (in-memory, no socket) Ktor server - same style as PetsApiRoutesTest.
class FormBodiesRoutesTest {
    @Test
    fun `subscribeToPet accepts an application_x-www-form-urlencoded body`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets/1/subscribe") {
            setBody(FormDataContent(Parameters.build {
                append("email", "me@example.com")
                append("notify", "true")
            }))
        }
        assertEquals(HttpStatusCode.NoContent, response.status)
    }

    @Test
    fun `subscribeToPet with a missing required email returns 400`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets/1/subscribe") {
            setBody(FormDataContent(Parameters.build {
                append("notify", "true")
            }))
        }
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    @Test
    fun `uploadPetPhoto accepts a multipart_form-data body`() = testApplication {
        val handler = FakePetsApiHandler()
        installKitchenSinkApp(petsHandler = handler)
        val response = client.post("/pets/1/photo") {
            setBody(MultiPartFormDataContent(formData {
                append("caption", "cute")
                append("photo", ByteArray(4), Headers.build {
                    append(HttpHeaders.ContentDisposition, "filename=\"rex.jpg\"")
                })
            }))
        }
        assertEquals(HttpStatusCode.NoContent, response.status)
        assertEquals("cute", handler.lastUploadedCaption)
        assertTrue(handler.lastUploadedPhotoSeen)
    }

    @Test
    fun `setPetNotes accepts and responds with a text_plain body`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/pets/1/notes") {
            contentType(ContentType.Text.Plain)
            setBody("likes belly rubs")
        }
        assertEquals(HttpStatusCode.OK, response.status)
        assertTrue(response.contentType()?.toString()?.startsWith("text/plain") == true)
        assertEquals("echo: likes belly rubs", response.bodyAsText())
    }

    @Test
    fun `uploadPetAvatar accepts and responds with an application_octet-stream body`() = testApplication {
        installKitchenSinkApp()
        val bytes = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47)
        val response = client.put("/pets/1/avatar") {
            contentType(ContentType.Application.OctetStream)
            setBody(bytes)
        }
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(ContentType.Application.OctetStream, response.contentType())
        assertContentEquals(bytes, response.bodyAsBytes())
    }
}

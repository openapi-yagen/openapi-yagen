package com.example.kitchensink.server

import com.example.kitchensink.server.fakes.FakePetsApiHandler
import com.example.kitchensink.server.support.installKitchenSinkApp
import io.ktor.client.request.forms.FormDataContent
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.Parameters
import io.ktor.server.testing.testApplication
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Exercises the two non-JSON request-body encodings this generator supports (see
// lib/operations.js's pickBodyContent/buildRequestBody and api_routes.kt.j2's
// receiveParameters()/receiveMultipart() branches) against a real (in-memory, no socket) Ktor
// server - same style as PetsApiRoutesTest.
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
}

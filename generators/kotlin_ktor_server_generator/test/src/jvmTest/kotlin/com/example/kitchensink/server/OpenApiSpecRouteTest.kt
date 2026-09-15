package com.example.kitchensink.server

import com.example.kitchensink.server.support.installKitchenSinkApp
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// build.gradle.kts's generateServer task passes -v publishOpenApiSpec=true, so OpenApiSpecRoute
// (mounted in installKitchenSinkApp - see support/TestApp.kt) should serve the effective spec this
// module was generated from.
class OpenApiSpecRouteTest {
    @Test
    fun `serves the effective OpenAPI document as JSON`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/openapi.json")
        assertEquals(HttpStatusCode.OK, response.status)
        assertEquals(ContentType.Application.Json, response.contentType()?.withoutParameters())

        val doc = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        assertTrue(doc["openapi"]!!.jsonPrimitive.content.startsWith("3."))
        val paths = doc["paths"]!!.jsonObject
        assertTrue(paths.containsKey("/pets"))
    }
}

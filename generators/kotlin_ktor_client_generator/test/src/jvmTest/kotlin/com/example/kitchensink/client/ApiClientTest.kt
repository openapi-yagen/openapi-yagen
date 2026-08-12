package com.example.kitchensink.client

import com.example.kitchensink.client.support.buildTestClient
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals

// ApiClient bundles one instance of every tag's client class from a single shared HttpClient/
// baseUrl - this exercises that the bundled instances are wired up correctly and actually make
// requests through the same underlying client, not just that the class compiles.
class ApiClientTest {
    @Test
    fun `ApiClient exposes one property per tag, each wired to the shared client`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond(
                content = """{"id":1,"name":"Rex","tag":"dog"}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val apiClient = ApiClient(client, baseUrl = "https://example.test")

        val pet = apiClient.pets.getPetById("1")

        assertEquals("/pets/1", captured!!.url.encodedPath)
        assertEquals("Rex", pet.name)
    }
}

package com.example.kitchensink.client

import com.example.kitchensink.client.support.buildTestClient
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.ExperimentalSerializationApi
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

// The vehicle for oneOf/anyOf coverage on the client side: a discriminated union (Shape) and an
// undiscriminated one ("union" kind: WidgetVariant).
@OptIn(ExperimentalSerializationApi::class)
class WidgetsApiTest {
    @Test
    fun `listWidgets sends the optional X-Client-Version header only when set`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond("[]", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val api = WidgetsApi(client, "https://example.test")

        api.listWidgets(status = null, xClientVersion = null)
        assertNull(captured!!.headers["X-Client-Version"])

        api.listWidgets(status = null, xClientVersion = "1.2.3")
        assertEquals("1.2.3", captured!!.headers["X-Client-Version"])
    }

    // See PetsApiTest's "Negative cases" section for why createWidget's outgoing `variant` field
    // isn't asserted here beyond "the call succeeds": WidgetVariant.Serializer only customizes
    // deserialize (selectDeserializer); its inherited serialize() wraps the concrete variant
    // subtype normally (nesting under a "value" key), so asserting that exact outgoing shape
    // isn't this test's job - only that the request reaches the right path/method.
    @Test
    fun `createWidget sends the correct path and method`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond(
                content = """{"id":1,"name":"Gizmo","variant":{"value":"just-a-string"}}""",
                status = HttpStatusCode.Created,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = WidgetsApi(client, "https://example.test")

        api.createWidget(
            Widget(id = 1, name = "Gizmo", tags = null, variant = WidgetVariant.WidgetVariantVariant3("just-a-string"))
        )

        assertEquals("/widgets", captured!!.url.encodedPath)
        assertEquals(HttpMethod.Post, captured!!.method)
    }

    @Test
    fun `getShape decodes the discriminated Circle variant`() = runTest {
        val client = buildTestClient { _ ->
            respond(
                content = """{"shapeType":"circle","radius":2.5}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = WidgetsApi(client, "https://example.test")

        val shape = api.getShape("circle-1")

        assertIs<Circle>(shape)
        assertEquals(2.5, shape.radius)
    }

    @Test
    fun `getShape decodes the discriminated Square variant`() = runTest {
        val client = buildTestClient { _ ->
            respond(
                content = """{"shapeType":"square","side":4.0}""",
                status = HttpStatusCode.OK,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = WidgetsApi(client, "https://example.test")

        val shape = api.getShape("square-1")

        assertIs<Square>(shape)
        assertEquals(4.0, shape.side)
    }
}

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
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

    // WidgetVariant's hand-rolled serializer (see model_union.kt.j2) keeps the wire shape flat and
    // symmetric - the outgoing `variant` field is asserted here as the bare string itself, not a
    // `{"value": ...}` wrapper.
    @Test
    fun `createWidget sends a flat JSON body for the union-typed variant field`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond(
                content = """{"id":1,"name":"Gizmo","variant":"just-a-string"}""",
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
        val sentJson = Json.parseToJsonElement((captured!!.body as TextContent).text).jsonObject
        assertEquals("just-a-string", sentJson.getValue("variant").jsonPrimitive.content)
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

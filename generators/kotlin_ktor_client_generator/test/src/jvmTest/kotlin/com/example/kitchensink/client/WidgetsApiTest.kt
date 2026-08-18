package com.example.kitchensink.client

import com.example.kitchensink.client.apis.WidgetsApi
import com.example.kitchensink.client.models.Circle
import com.example.kitchensink.client.models.Shape
import com.example.kitchensink.client.models.Square
import com.example.kitchensink.client.models.Widget
import com.example.kitchensink.client.models.WidgetsApiListWidgetsStatus
import com.example.kitchensink.client.models.WidgetVariant
import com.example.kitchensink.client.models.WidgetVariantC
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
import kotlinx.serialization.json.int
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

    // "status" is enum-typed (WidgetsApiListWidgetsStatus) - its wire value ("sold-out") differs
    // from the Kotlin enum constant name (SOLD_OUT), so this exercises toString() emitting the
    // wire value into the query string, not the constant name (see model_enum.kt.j2).
    @Test
    fun `listWidgets sends the enum-typed status query parameter as its wire value`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond("[]", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val api = WidgetsApi(client, "https://example.test")

        api.listWidgets(status = WidgetsApiListWidgetsStatus.SOLD_OUT, xClientVersion = null)

        assertEquals("sold-out", captured!!.url.parameters["status"])
    }

    // "id" is a primitive-shaped anyOf (integer or string) - passed straight through as a plain
    // String rather than the JSON-shape-dispatching "union" model, since a query value is always
    // just a string on the wire anyway (see operations.js's isPrimitiveLikeUnion).
    @Test
    fun `listWidgets sends the primitive-shaped anyOf id query parameter as a plain string`() = runTest {
        var captured: HttpRequestData? = null
        val client = buildTestClient { request ->
            captured = request
            respond("[]", HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        val api = WidgetsApi(client, "https://example.test")

        api.listWidgets(status = null, id = "512189", xClientVersion = null)

        assertEquals("512189", captured!!.url.parameters["id"])
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

    // WidgetVariantC is disambiguated by an optional (not required) property unique to it
    // ("note") - exercises findUniqueDistinguishingField's fallback beyond `required` fields.
    @Test
    fun `createWidget decodes the optional-field-disambiguated union variant`() = runTest {
        val client = buildTestClient { _ ->
            respond(
                content = """{"id":1,"name":"Gizmo","variant":{"note":"just a note"}}""",
                status = HttpStatusCode.Created,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = WidgetsApi(client, "https://example.test")

        val widget = api.createWidget(
            Widget(id = 1, name = "Gizmo", tags = null, variant = WidgetVariant.WidgetVariantVariant3("ignored"))
        )

        val variant = widget.variant
        assertIs<WidgetVariant.WidgetVariantWidgetVariantC>(variant)
        assertEquals("just a note", variant.value.note)
    }

    // The trailing unconstrained ("{}") catch-all variant matches any JSON shape none of the
    // other variants recognize - here a bare number, which isn't string/object/array.
    @Test
    fun `createWidget decodes the catch-all union variant for an unrecognized JSON shape`() = runTest {
        val client = buildTestClient { _ ->
            respond(
                content = """{"id":1,"name":"Gizmo","variant":42}""",
                status = HttpStatusCode.Created,
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        }
        val api = WidgetsApi(client, "https://example.test")

        val widget = api.createWidget(
            Widget(id = 1, name = "Gizmo", tags = null, variant = WidgetVariant.WidgetVariantVariant3("ignored"))
        )

        val variant = widget.variant
        assertIs<WidgetVariant.WidgetVariantVariant5>(variant)
        assertEquals(42, variant.value.jsonPrimitive.int)
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

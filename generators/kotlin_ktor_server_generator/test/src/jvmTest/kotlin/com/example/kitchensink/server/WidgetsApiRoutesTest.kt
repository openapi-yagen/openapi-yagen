package com.example.kitchensink.server

import com.example.kitchensink.server.models.Circle
import com.example.kitchensink.server.models.Shape
import com.example.kitchensink.server.models.Square
import com.example.kitchensink.server.models.Widget
import com.example.kitchensink.server.models.WidgetVariant
import com.example.kitchensink.server.models.Widgets
import com.example.kitchensink.server.support.installKitchenSinkApp
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs

// Runs the generated WidgetsApiRoutes - the vehicle for the oneOf/anyOf coverage: a discriminated
// union (Shape: Circle/Square) and an undiscriminated one ("union" kind: WidgetVariant), plus a
// Set<Tag>-backed array field (TagSet, contrasted with Pets' plain List<Pet> in
// PetsApiRoutesTest.kt).
@OptIn(ExperimentalSerializationApi::class)
class WidgetsApiRoutesTest {
    @Test
    fun `listWidgets returns 200 with an empty list initially`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/widgets")
        assertEquals(HttpStatusCode.OK, response.status)
        val widgets = Json.decodeFromString<Widgets>(response.bodyAsText())
        assertEquals(0, widgets.size)
    }

    @Test
    fun `listWidgets accepts an optional X-Client-Version header`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/widgets") { header("X-Client-Version", "1.2.3") }
        assertEquals(HttpStatusCode.OK, response.status)
    }

    // "status" is enum-typed (WidgetsApiListWidgetsStatus) - its wire value ("sold-out") differs
    // from the Kotlin enum constant name (SOLD_OUT); fromWireValue parses the wire value back
    // correctly (see model_enum.kt.j2).
    @Test
    fun `listWidgets accepts a recognized enum-typed status query parameter`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/widgets?status=sold-out")
        assertEquals(HttpStatusCode.OK, response.status)
    }

    // An unrecognized value is rejected as a 400, the same quality as a malformed numeric param
    // (see validation.kt.j2's convertOrThrow, which now catches IllegalArgumentException broadly
    // rather than just NumberFormatException).
    @Test
    fun `listWidgets rejects an unrecognized status query parameter with 400`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/widgets?status=nonexistent")
        assertEquals(HttpStatusCode.BadRequest, response.status)
    }

    // "id" is a primitive-shaped anyOf (integer or string) - accepted as a plain String with no
    // parsing/validation attempted, whether the value looks numeric or not (see operations.js's
    // isPrimitiveLikeUnion).
    @Test
    fun `listWidgets accepts either shape of the primitive-shaped anyOf id query parameter`() = testApplication {
        installKitchenSinkApp()
        assertEquals(HttpStatusCode.OK, client.get("/widgets?id=512189").status)
        assertEquals(HttpStatusCode.OK, client.get("/widgets?id=some-slug").status)
    }

    // WidgetVariant.Serializer dispatches on the raw JSON shape: an object with "kind" ->
    // WidgetVariantA, an object with "label" -> WidgetVariantB, a bare string -> the inline
    // string variant (see kitchensink.yaml's WidgetVariant schema). Both directions are flat and
    // symmetric (see model_union.kt.j2's hand-rolled serializer), so the echoed `variant` field's
    // exact shape is asserted here too, not just that the request was accepted.
    @Test
    fun `createWidget accepts and echoes back an object-shaped union variant`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/widgets") {
            contentType(ContentType.Application.Json)
            setBody(
                """{"id":1,"name":"Gizmo","tags":[{"id":1,"name":"shiny"},{"id":2,"name":"small"}],
                   |"variant":{"kind":"a","value":42}}""".trimMargin()
            )
        }
        assertEquals(HttpStatusCode.Created, response.status)
        val widget = Json.decodeFromString<Widget>(response.bodyAsText())
        assertEquals("Gizmo", widget.name)
        assertEquals(2, widget.tags?.size)
        val variant = widget.variant
        assertIs<WidgetVariant.WidgetVariantWidgetVariantA>(variant)
        assertEquals("a", variant.value.kind)
        assertEquals(42, variant.value.value)
    }

    @Test
    fun `createWidget accepts and echoes back the plain-string union variant`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/widgets") {
            contentType(ContentType.Application.Json)
            setBody("""{"id":2,"name":"Thingy","variant":"just-a-string"}""")
        }
        assertEquals(HttpStatusCode.Created, response.status)
        val widget = Json.decodeFromString<Widget>(response.bodyAsText())
        val variant = widget.variant
        assertIs<WidgetVariant.WidgetVariantVariant3>(variant)
        assertEquals("just-a-string", variant.value)
    }

    // WidgetVariantC is disambiguated by an optional (not required) property unique to it
    // ("note") - exercises findUniqueDistinguishingField's fallback beyond `required` fields.
    @Test
    fun `createWidget accepts and echoes back the optional-field-disambiguated union variant`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/widgets") {
            contentType(ContentType.Application.Json)
            setBody("""{"id":3,"name":"Doohickey","variant":{"note":"just a note"}}""")
        }
        assertEquals(HttpStatusCode.Created, response.status)
        val widget = Json.decodeFromString<Widget>(response.bodyAsText())
        val variant = widget.variant
        assertIs<WidgetVariant.WidgetVariantWidgetVariantC>(variant)
        assertEquals("just a note", variant.value.note)
    }

    // The trailing unconstrained ("{}") catch-all variant matches any JSON shape none of the
    // other variants recognize - here a bare number, which isn't string/object/array.
    @Test
    fun `createWidget accepts and echoes back the catch-all union variant`() = testApplication {
        installKitchenSinkApp()
        val response = client.post("/widgets") {
            contentType(ContentType.Application.Json)
            setBody("""{"id":4,"name":"Whatsit","variant":42}""")
        }
        assertEquals(HttpStatusCode.Created, response.status)
        val widget = Json.decodeFromString<Widget>(response.bodyAsText())
        val variant = widget.variant
        assertIs<WidgetVariant.WidgetVariantVariant5>(variant)
        assertEquals(42, variant.value.jsonPrimitive.int)
    }

    @Test
    fun `getShape returns the discriminated Circle variant`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/widgets/shapes/circle-1")
        assertEquals(HttpStatusCode.OK, response.status)
        val shape = Json.decodeFromString<Shape>(response.bodyAsText())
        assertIs<Circle>(shape)
        assertEquals(2.5, shape.radius)
    }

    @Test
    fun `getShape returns the discriminated Square variant`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/widgets/shapes/square-1")
        assertEquals(HttpStatusCode.OK, response.status)
        val shape = Json.decodeFromString<Shape>(response.bodyAsText())
        assertIs<Square>(shape)
        assertEquals(4.0, shape.side)
    }

    @Test
    fun `getShape for an unknown id returns 404`() = testApplication {
        installKitchenSinkApp()
        val response = client.get("/widgets/shapes/does-not-exist")
        assertEquals(HttpStatusCode.NotFound, response.status)
    }

    // favoriteWidget: security: [{oauth2Auth}, {apiKeyAuth}] - a plain OR between two single-scheme
    // alternatives. oauth2Auth is handled identically to a bearer token (RFC 6750).
    @Test
    fun `favoriteWidget requires either oauth2Auth or apiKeyAuth`() = testApplication {
        installKitchenSinkApp()

        val neither = client.post("/widgets/w1/favorite")
        assertEquals(HttpStatusCode.Unauthorized, neither.status)

        val withOauth2 = client.post("/widgets/w1/favorite") { header("Authorization", "Bearer sometoken") }
        assertEquals(HttpStatusCode.NoContent, withOauth2.status)

        val withApiKey = client.post("/widgets/w1/favorite") { header("X-Api-Key", "secret") }
        assertEquals(HttpStatusCode.NoContent, withApiKey.status)
    }

    // archiveWidget: security: [{oauth2Auth, apiKeyAuth}, {bearerAuth}] - one alternative itself
    // requires two schemes together (AND-within-OR), exercising authTry's nested-if recursion
    // beyond a single scheme, not just authAlternative's OR-loop.
    @Test
    fun `archiveWidget requires both schemes of the AND-combined alternative, or bearerAuth alone`() = testApplication {
        installKitchenSinkApp()

        val neither = client.post("/widgets/w1/archive")
        assertEquals(HttpStatusCode.Unauthorized, neither.status)

        // Only one of the two AND-combined schemes (apiKeyAuth, no Authorization) - not enough on
        // its own, and the second alternative (bearerAuth) isn't satisfied either.
        val onlyApiKey = client.post("/widgets/w1/archive") { header("X-Api-Key", "secret") }
        assertEquals(HttpStatusCode.Unauthorized, onlyApiKey.status)

        // Both schemes the first alternative requires together.
        val bothCombined = client.post("/widgets/w1/archive") {
            header("X-Api-Key", "secret")
            header("Authorization", "Bearer sometoken")
        }
        assertEquals(HttpStatusCode.NoContent, bothCombined.status)

        // Second alternative (bearerAuth alone) also satisfies the request on its own.
        val bearerAlone = client.post("/widgets/w1/archive") { header("Authorization", "Bearer sometoken") }
        assertEquals(HttpStatusCode.NoContent, bearerAlone.status)
    }
}

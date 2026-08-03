package com.example.kitchensink.server

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
}

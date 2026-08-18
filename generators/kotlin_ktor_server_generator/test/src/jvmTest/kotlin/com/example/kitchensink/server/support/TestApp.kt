package com.example.kitchensink.server.support

import com.example.kitchensink.server.apis.PetsApiHandler
import com.example.kitchensink.server.apis.PetsApiRoutes
import com.example.kitchensink.server.apis.WidgetsApiHandler
import com.example.kitchensink.server.apis.WidgetsApiRoutes
import com.example.kitchensink.server.fakes.FakePetsApiHandler
import com.example.kitchensink.server.fakes.FakeWidgetsApiHandler
import com.example.kitchensink.server.fakes.NotFoundException
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.install
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respondText
import io.ktor.server.routing.routing
import io.ktor.server.testing.ApplicationTestBuilder

// A literal transcription of this generator's own README "Integrating the generated code"
// section (ContentNegotiation + StatusPages mapping BadRequestException to 400 - Validation.kt
// itself wraps a non-numeric parameter value as a BadRequestException, no separate
// NumberFormatException mapping needed), plus one addition this test suite introduces itself:
// mapping a test-local NotFoundException to 404. That mapping is NOT a generator feature - "not
// found" is business logic the generator has no opinion about (see the README's "Known
// limitations"); a real integrator is expected to define and map their own such exception exactly
// like this.
fun ApplicationTestBuilder.installKitchenSinkApp(
    petsHandler: PetsApiHandler = FakePetsApiHandler(),
    widgetsHandler: WidgetsApiHandler = FakeWidgetsApiHandler(),
) {
    application {
        install(ContentNegotiation) { json() }
        install(StatusPages) {
            exception<BadRequestException> { call, e ->
                call.respondText(e.message ?: "Bad request", status = HttpStatusCode.BadRequest)
            }
            exception<NotFoundException> { call, e ->
                call.respondText(e.message ?: "Not found", status = HttpStatusCode.NotFound)
            }
        }
        routing {
            PetsApiRoutes(this, petsHandler)
            WidgetsApiRoutes(this, widgetsHandler)
        }
    }
}

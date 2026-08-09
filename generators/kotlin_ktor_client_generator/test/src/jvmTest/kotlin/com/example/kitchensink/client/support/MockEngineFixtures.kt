package com.example.kitchensink.client.support

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandler
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json

// Builds an HttpClient wired to a MockEngine that runs `handler` for every request - no real
// network/socket involved. Mirrors this generator's own README "Integrating the generated code"
// ContentNegotiation setup, just on a MockEngine instead of a real HTTP engine.
fun buildTestClient(handler: MockRequestHandler): HttpClient =
    HttpClient(MockEngine(handler)) {
        install(ContentNegotiation) { json() }
    }

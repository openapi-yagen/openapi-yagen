package com.example.kitchensink.server.fakes

// Test-local exception type - NOT part of the generated code. "Not found" is business logic the
// server generator has no opinion about (see its README's "Known limitations"); a real
// integrator defines their own such exception and maps it via StatusPages, exactly as
// demonstrated in support/TestApp.kt.
class NotFoundException(message: String) : RuntimeException(message)

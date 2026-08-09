package com.example.kitchensink.server.fakes

import com.example.kitchensink.server.NewPet
import com.example.kitchensink.server.Pet
import com.example.kitchensink.server.Pets
import com.example.kitchensink.server.PetsApiHandler
import com.example.kitchensink.server.Rating

// Hand-written fake implementation of the generated PetsApiHandler interface - an in-memory
// store, just enough business logic for the tests in ../PetsApiRoutesTest.kt to exercise every
// generated route's positive and negative behavior.
class FakePetsApiHandler : PetsApiHandler {
    private val pets = linkedMapOf(
        "1" to Pet(id = 1, name = "Rex", tag = "dog", notes = null, status = null),
    )
    private var nextId = 2

    override suspend fun listPets(limit: Int?, tag: String?): Pets {
        val filtered = pets.values.filter { tag == null || it.tag == tag }
        return if (limit != null) filtered.take(limit) else filtered.toList()
    }

    override suspend fun createPet(body: NewPet): Pet {
        val id = nextId++
        val pet = Pet(id = id, name = body.name, tag = body.tag, notes = body.notes, status = body.status)
        pets[id.toString()] = pet
        return pet
    }

    override suspend fun getPetById(petId: String): Pet =
        pets[petId] ?: throw NotFoundException("pet $petId not found")

    override suspend fun deletePet(petId: String) {
        pets.remove(petId) ?: throw NotFoundException("pet $petId not found")
    }

    override suspend fun ratePet(petId: String, xRequestId: String, body: Rating) {
        // Only cares that a known pet exists and that validated params/header/body reached here
        // intact - the rating itself isn't persisted anywhere in this fake.
        pets[petId] ?: throw NotFoundException("pet $petId not found")
    }
}

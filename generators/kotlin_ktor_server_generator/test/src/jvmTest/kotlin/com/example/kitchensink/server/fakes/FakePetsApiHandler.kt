package com.example.kitchensink.server.fakes

import com.example.kitchensink.server.apis.PetsApiHandler
import com.example.kitchensink.server.models.NewPet
import com.example.kitchensink.server.models.Pet
import com.example.kitchensink.server.models.Pets
import com.example.kitchensink.server.models.PetSubscription
import com.example.kitchensink.server.models.Rating
import io.ktor.http.content.MultiPartData
import io.ktor.http.content.forEachPart
import kotlinx.datetime.Instant

// Hand-written fake implementation of the generated PetsApiHandler interface - an in-memory
// store, just enough business logic for the tests in ../PetsApiRoutesTest.kt to exercise every
// generated route's positive and negative behavior.
class FakePetsApiHandler : PetsApiHandler {
    private val pets = linkedMapOf(
        "1" to Pet(
            id = 1,
            name = "Rex",
            tag = "dog",
            notes = null,
            status = null,
            createdAt = Instant.parse("2024-01-15T10:30:00Z"),
        ),
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

    override suspend fun deletePet(petId: String, bearerAuth: String) {
        // The fake doesn't check the token's value - PetsApiRoutesTest only exercises that
        // Validation.kt's extraction/presence check runs before the handler is ever called.
        pets.remove(petId) ?: throw NotFoundException("pet $petId not found")
    }

    override suspend fun ratePet(petId: String, xRequestId: String, apiKeyAuth: String, body: Rating) {
        // Only cares that a known pet exists and that validated params/header/apiKey/body reached
        // here intact - the rating itself isn't persisted anywhere in this fake.
        pets[petId] ?: throw NotFoundException("pet $petId not found")
    }

    // Just consumes the multipart parts to prove the generated route/handler wiring actually
    // delivers a receiveMultipart()-backed MultiPartData through, same "not persisted" spirit as
    // ratePet above.
    var lastUploadedCaption: String? = null
        private set
    var lastUploadedPhotoSeen: Boolean = false
        private set

    override suspend fun uploadPetPhoto(petId: String, body: MultiPartData) {
        pets[petId] ?: throw NotFoundException("pet $petId not found")
        body.forEachPart { part ->
            when (part) {
                is io.ktor.http.content.PartData.FormItem -> if (part.name == "caption") lastUploadedCaption = part.value
                is io.ktor.http.content.PartData.FileItem -> if (part.name == "photo") lastUploadedPhotoSeen = true
                else -> {}
            }
            part.dispose()
        }
    }

    override suspend fun subscribeToPet(petId: String, body: PetSubscription) {
        pets[petId] ?: throw NotFoundException("pet $petId not found")
    }

    override suspend fun setPetNotes(petId: String, body: String): String {
        pets[petId] ?: throw NotFoundException("pet $petId not found")
        return "echo: $body"
    }

    override suspend fun uploadPetAvatar(petId: String, body: ByteArray): ByteArray {
        pets[petId] ?: throw NotFoundException("pet $petId not found")
        return body
    }
}

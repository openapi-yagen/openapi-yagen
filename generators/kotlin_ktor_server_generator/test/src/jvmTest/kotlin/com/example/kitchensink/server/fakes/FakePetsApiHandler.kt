package com.example.kitchensink.server.fakes

import com.example.kitchensink.server.apis.PetsApiHandler
import com.example.kitchensink.server.models.NewPet
import com.example.kitchensink.server.models.Pet
import com.example.kitchensink.server.models.Pets
import com.example.kitchensink.server.models.PetPhotoUpload
import com.example.kitchensink.server.models.PetSubscription
import com.example.kitchensink.server.models.Rating
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

    // The fake doesn't branch on sessionId's value - PetsApiRoutesTest only exercises that
    // Validation.kt's cookie extraction runs and reaches the handler intact.
    var lastSeenSessionId: String? = null
        private set

    override suspend fun listPets(limit: Int?, tag: String?, sessionId: String?): Pets {
        lastSeenSessionId = sessionId
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

    // Records what the generated route actually extracted from the multipart body, to prove the
    // per-field extraction (formFieldAs/formFieldListAs/requireFormFileAs - see Validation.kt and
    // api_routes.kt.j2) delivers a clean, already-typed PetPhotoUpload, same "not persisted" spirit
    // as ratePet above.
    var lastUploadedCaption: String? = null
        private set
    var lastUploadedAlbums: List<String>? = null
        private set
    var lastUploadedPhotoSize: Int = -1
        private set

    override suspend fun uploadPetPhoto(petId: String, body: PetPhotoUpload) {
        pets[petId] ?: throw NotFoundException("pet $petId not found")
        lastUploadedCaption = body.caption
        lastUploadedAlbums = body.albums
        lastUploadedPhotoSize = body.photo.size
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

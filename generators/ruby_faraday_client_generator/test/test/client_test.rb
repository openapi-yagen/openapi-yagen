require_relative "test_helper"

# End-to-end tests through the generated client classes, over Faraday::Adapter::Test (built into
# the faraday gem itself - no separate mocking library, no real network) - the Ruby equivalent of
# the TypeScript generator's hand-rolled fetch stub / the Kotlin generator's ktor-client-mock.
class ClientTest < Minitest::Test
  def stubbed_connection
    stubs = Faraday::Adapter::Test::Stubs.new
    yield stubs
    conn = Faraday.new { |f| f.adapter :test, stubs }
    [conn, stubs]
  end

  # Wired from the spec's `in: cookie` session_id parameter (see listPets in kitchensink.yaml) -
  # proves it's actually sent on the Cookie header, not silently dropped (Faraday isn't
  # browser-sandboxed the way the TypeScript fetch client is, so this is a real feature here).
  def test_list_pets_sends_the_session_id_cookie_parameter_on_the_cookie_header
    conn, stubs = stubbed_connection do |stub|
      stub.get("/pets") do |env|
        assert_equal "session_id=abc123", env.request_headers["Cookie"]
        [200, { "Content-Type" => "application/json" }, "[]"]
      end
    end
    api = Kitchensink::PetsClient.new(connection: conn)

    api.list_pets(session_id: "abc123")

    stubs.verify_stubbed_calls
  end

  def test_get_pet_by_id_positive
    conn, stubs = stubbed_connection do |stub|
      stub.get("/pets/42") { [200, { "Content-Type" => "application/json" }, '{"id":42,"name":"Rex"}'] }
    end
    api = Kitchensink::PetsClient.new(connection: conn)

    pet = api.get_pet_by_id(pet_id: "42")

    assert_instance_of Kitchensink::Pet, pet
    assert_equal 42, pet.id
    assert_equal "Rex", pet.name
    stubs.verify_stubbed_calls
  end

  def test_get_pet_by_id_not_found_raises_api_error
    conn, stubs = stubbed_connection do |stub|
      stub.get("/pets/999") { [404, { "Content-Type" => "application/json" }, '{"code":404,"message":"not found"}'] }
    end
    api = Kitchensink::PetsClient.new(connection: conn)

    error = assert_raises(OpenapiYagenRuntime::ApiError) { api.get_pet_by_id(pet_id: "999") }

    assert_equal 404, error.status
    assert_equal "not found", error.response_body["message"]
    stubs.verify_stubbed_calls
  end

  def test_create_pet_sends_json_body_and_parses_response
    conn, stubs = stubbed_connection do |stub|
      stub.post("/pets") do |env|
        assert_equal "application/json", env.request_headers["Content-Type"]
        assert_equal({ "name" => "Rex", "priority" => 1, "visibility" => "public" }, JSON.parse(env.body))
        [201, { "Content-Type" => "application/json" }, '{"id":1,"name":"Rex"}']
      end
    end
    api = Kitchensink::PetsClient.new(connection: conn)

    pet = api.create_pet(body: Kitchensink::NewPet.new(name: "Rex"))

    assert_equal 1, pet.id
    stubs.verify_stubbed_calls
  end

  def test_delete_pet_without_auth_raises_before_sending_a_request
    conn, stubs = stubbed_connection { |_stub| } # no stub registered - a request here would fail the test
    api = Kitchensink::PetsClient.new(connection: conn)

    assert_raises(ArgumentError) { api.delete_pet(pet_id: "1") }
    stubs.verify_stubbed_calls
  end

  def test_delete_pet_with_bearer_auth_positive
    conn, stubs = stubbed_connection do |stub|
      stub.delete("/pets/1") do |env|
        assert_equal "Bearer tok", env.request_headers["Authorization"]
        [204, {}, ""]
      end
    end
    api = Kitchensink::PetsClient.new(connection: conn, auth: { bearer: "tok" })

    result = api.delete_pet(pet_id: "1")

    assert_nil result
    stubs.verify_stubbed_calls
  end

  def test_rate_pet_sends_api_key_header_and_custom_header
    conn, stubs = stubbed_connection do |stub|
      stub.post("/pets/1/ratings") do |env|
        assert_equal "secret", env.request_headers["X-Api-Key"]
        assert_equal "req-1", env.request_headers["X-Request-Id"]
        assert_equal({ "score" => 5, "label" => "great" }, JSON.parse(env.body))
        [204, {}, ""]
      end
    end
    api = Kitchensink::PetsClient.new(connection: conn, auth: { api_key: "secret" })

    result = api.rate_pet(pet_id: "1", x_request_id: "req-1", body: Kitchensink::Rating.new(score: 5, label: "great"))

    assert_nil result
    stubs.verify_stubbed_calls
  end

  def test_upload_pet_photo_sends_multipart_body_untouched_for_the_callers_own_middleware
    # A `format: binary` field isn't a plain String on the wire - a real caller passes a File/IO or
    # a Faraday::Multipart::FilePart-shaped UploadIO, exactly as README.md's own usage example
    # shows. This must NOT raise (see require_string_or_file in runtime.rb, and the format: binary
    # exemption in serialization.js's buildValidateStatements) - a prior version of this generator's
    # validate! required a plain String here, making that documented example crash with TypeError.
    photo = StringIO.new("raw-bytes")
    conn, stubs = stubbed_connection do |stub|
      stub.post("/pets/1/photo") do |env|
        # No Content-Type set by us, and the body stays a plain Hash (not a JSON string) - it's the
        # caller's own installed Faraday::Multipart::Middleware that would encode it for a real
        # request; this test has none installed, so we can assert on the raw pre-encoding shape.
        refute env.request_headers.key?("Content-Type")
        assert_equal("cute", env.body["caption"])
        assert_same photo, env.body["photo"]
        [204, {}, ""]
      end
    end
    api = Kitchensink::PetsClient.new(connection: conn)

    result = api.upload_pet_photo(pet_id: "1", body: Kitchensink::PetPhotoUpload.new(caption: "cute", photo: photo))

    assert_nil result
    stubs.verify_stubbed_calls
  end

  def test_pet_photo_upload_validate_rejects_a_value_that_is_neither_string_nor_file_like
    body = Kitchensink::PetPhotoUpload.new(caption: "cute", photo: 123)

    error = assert_raises(TypeError) { body.validate! }
    assert_match(/"photo"/, error.message)
  end

  def test_subscribe_to_pet_sends_urlencoded_body
    conn, stubs = stubbed_connection do |stub|
      stub.post("/pets/1/subscribe") do |env|
        assert_equal "application/x-www-form-urlencoded", env.request_headers["Content-Type"]
        assert_equal({ "email" => "me@example.com", "notify" => "true" }, URI.decode_www_form(env.body).to_h)
        [204, {}, ""]
      end
    end
    api = Kitchensink::PetsClient.new(connection: conn)

    result = api.subscribe_to_pet(pet_id: "1", body: Kitchensink::PetSubscription.new(email: "me@example.com", notify: true))

    assert_nil result
    stubs.verify_stubbed_calls
  end

  # An array-typed urlencoded field (channels) sends one repeated key per element - stdlib's
  # URI.encode_www_form already does this for an Array-valued Hash entry with no code of this
  # generator's own needed for it (see operations.js's requireFlatObjectSchema).
  def test_subscribe_to_pet_serializes_an_array_typed_urlencoded_field_as_repeated_keys
    conn, stubs = stubbed_connection do |stub|
      stub.post("/pets/1/subscribe") do |env|
        pairs = URI.decode_www_form(env.body)
        assert_equal ["sms", "email"], pairs.select { |k, _| k == "channels" }.map { |_, v| v }
        [204, {}, ""]
      end
    end
    api = Kitchensink::PetsClient.new(connection: conn)

    api.subscribe_to_pet(pet_id: "1", body: Kitchensink::PetSubscription.new(email: "me@example.com", channels: ["sms", "email"]))

    stubs.verify_stubbed_calls
  end

  def test_set_pet_notes_sends_and_parses_a_text_plain_body_as_a_plain_string
    conn, stubs = stubbed_connection do |stub|
      stub.post("/pets/1/notes") do |env|
        assert_equal "text/plain", env.request_headers["Content-Type"]
        assert_equal "likes belly rubs", env.body
        [200, { "Content-Type" => "text/plain" }, "echo: likes belly rubs"]
      end
    end
    api = Kitchensink::PetsClient.new(connection: conn)

    result = api.set_pet_notes(pet_id: "1", body: "likes belly rubs")

    assert_equal "echo: likes belly rubs", result
    stubs.verify_stubbed_calls
  end

  def test_upload_pet_avatar_sends_and_parses_an_application_octet_stream_body_as_raw_bytes
    bytes = [0x89, 0x50, 0x4e, 0x47].pack("C*")
    conn, stubs = stubbed_connection do |stub|
      stub.put("/pets/1/avatar") do |env|
        assert_equal "application/octet-stream", env.request_headers["Content-Type"]
        assert_equal bytes, env.body
        [200, { "Content-Type" => "application/octet-stream" }, bytes]
      end
    end
    api = Kitchensink::PetsClient.new(connection: conn)

    result = api.upload_pet_avatar(pet_id: "1", body: bytes)

    assert_equal bytes, result
    assert_equal Encoding::ASCII_8BIT, result.encoding
    stubs.verify_stubbed_calls
  end

  def test_get_shape_dispatches_discriminated_union_from_an_http_response
    conn, stubs = stubbed_connection do |stub|
      stub.get("/widgets/shapes/s1") { [200, { "Content-Type" => "application/json" }, '{"shapeType":"circle","radius":2}'] }
    end
    api = Kitchensink::WidgetsClient.new(connection: conn)

    shape = api.get_shape(shape_id: "s1")

    assert_instance_of Kitchensink::Circle, shape
    assert_equal 2, shape.radius
    stubs.verify_stubbed_calls
  end

  def test_api_client_bundles_every_tag
    conn, _stubs = stubbed_connection { |_stub| }
    api = Kitchensink::ApiClient.new(connection: conn)

    assert_instance_of Kitchensink::PetsClient, api.pets
    assert_instance_of Kitchensink::WidgetsClient, api.widgets
  end
end

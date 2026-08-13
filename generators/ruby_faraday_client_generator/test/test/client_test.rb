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
        assert_equal({ "name" => "Rex" }, JSON.parse(env.body))
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

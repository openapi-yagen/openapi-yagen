require_relative "test_helper"
require "rack/test/uploaded_file"
require "json"

# Exercises the generated routes/controllers end to end against the real generated code, driven
# by Rack::Test against the bare ActionDispatch::Routing::RouteSet built in test_helper.rb - no
# real socket/network involved. Mirrors the positive+negative matrix the Tornado/Go/Kotlin server
# generators' own test suites already exercise: happy path, 422 validation, 401 auth, cookies,
# multipart, array query params.
class ControllerTest < Minitest::Test
  include Rack::Test::Methods

  def app
    ROUTES
  end

  # FakePetsHandler is one shared instance across the whole run (registered once when the
  # RouteSet is drawn in test_helper.rb) - Minitest runs test methods in random order, so any test
  # that mutates its @pets (create/delete) would otherwise leak into whichever test runs next.
  # Reset before every test instead of drawing a fresh RouteSet each time.
  def setup
    handler = Kitchensink::Controllers::PetsController.handler
    handler.instance_variable_set(:@pets, { 1 => FakePetsHandler::Pet.new(1, "Rex", "dog", nil, "available", nil, nil, nil) })
    handler.instance_variable_set(:@next_id, 2)
  end

  def test_get_by_id_happy_path
    get "/pets/1"
    assert_equal 200, last_response.status
    assert_equal({ "id" => 1, "name" => "Rex", "tag" => "dog", "status" => "available" }, JSON.parse(last_response.body))
  end

  def test_create_then_fetch_round_trip
    post "/pets", { name: "Fido", tag: "dog" }.to_json, { "CONTENT_TYPE" => "application/json" }
    assert_equal 201, last_response.status
    created = JSON.parse(last_response.body)
    assert_equal "Fido", created["name"]

    get "/pets/#{created["id"]}"
    assert_equal 200, last_response.status
    assert_equal "Fido", JSON.parse(last_response.body)["name"]
  end

  def test_create_pet_returns_422_on_a_constraint_violation
    post "/pets", { name: "" }.to_json, { "CONTENT_TYPE" => "application/json" }
    assert_equal 422, last_response.status
    assert_match(/"name" must have length/, JSON.parse(last_response.body)["error"])
  end

  def test_delete_pet_requires_bearer_auth
    delete "/pets/1"
    assert_equal 401, last_response.status
    assert_match(/bearer token/, JSON.parse(last_response.body)["error"])
  end

  def test_delete_pet_succeeds_with_bearer_auth
    delete "/pets/1", {}, { "HTTP_AUTHORIZATION" => "Bearer some-token" }
    assert_equal 204, last_response.status
    assert_empty last_response.body
  end

  # OpenAPI 3's default array query serialization (a repeated key, "tags=a&tags=b") - NOT
  # collected into an array by Rails' own `params` (see runtime.rb#query_array's own comment) -
  # this asserts the round-trip actually works end to end through a real request, not just
  # runtime_test.rb's direct unit test of query_array itself.
  def test_array_query_parameter_is_collected_via_repeated_key
    original = FakePetsHandler.instance_method(:list_pets)
    seen = nil
    FakePetsHandler.define_method(:list_pets) do |limit: nil, tag: nil, tags: nil, session_id: nil|
      seen = tags
      Kitchensink::Pets.from_h([])
    end
    get "/pets?tags=a&tags=b"
    assert_equal 200, last_response.status
    assert_equal ["a", "b"], seen
  ensure
    FakePetsHandler.define_method(:list_pets, original)
  end

  def test_cookie_parameter_is_readable_by_the_handler
    original = FakePetsHandler.instance_method(:list_pets)
    seen = nil
    FakePetsHandler.define_method(:list_pets) do |limit: nil, tag: nil, tags: nil, session_id: nil|
      seen = session_id
      Kitchensink::Pets.from_h([])
    end
    get "/pets", {}, { "HTTP_COOKIE" => "session_id=abc123" }
    assert_equal 200, last_response.status
    assert_equal "abc123", seen
  ensure
    FakePetsHandler.define_method(:list_pets, original)
  end

  def test_multipart_file_upload
    file = Rack::Test::UploadedFile.new(StringIO.new("binarydata"), "image/jpeg", true, original_filename: "rex.jpg")
    post "/pets/1/photo", { caption: "Rex at the park", photo: file }
    assert_equal 204, last_response.status
  end

  def test_urlencoded_body
    post "/pets/1/subscribe", { email: "rex@example.com", notify: true }, { "CONTENT_TYPE" => "application/x-www-form-urlencoded" }
    assert_equal 204, last_response.status
  end

  def test_raw_bytes_request_and_response_body
    bytes = "\x89PNG raw bytes".b # binary literal - raw_post comes back ASCII-8BIT, not UTF-8
    put "/pets/1/avatar", bytes, { "CONTENT_TYPE" => "application/octet-stream" }
    assert_equal 200, last_response.status
    assert_equal "application/octet-stream", last_response.content_type
    assert_equal bytes, last_response.body.b
  end

  def test_text_plain_request_and_response_body
    post "/pets/1/notes", "just a plain string", { "CONTENT_TYPE" => "text/plain" }
    assert_equal 200, last_response.status
    assert_equal "text/plain", last_response.content_type
    assert_equal "just a plain string", last_response.body
  end

  # A single AND-group alternative (oauth2Auth AND apiKeyAuth together) OR a second, single-scheme
  # alternative (bearerAuth alone) - satisfying EITHER should succeed; satisfying neither shouldn't.
  def test_archive_widget_and_or_auth_alternatives
    post "/widgets/w1/archive"
    assert_equal 401, last_response.status

    post "/widgets/w1/archive", {}, { "HTTP_AUTHORIZATION" => "Bearer tok" } # 2nd alternative alone
    assert_equal 204, last_response.status

    post "/widgets/w1/archive", {}, { "HTTP_X_API_KEY" => "key1" } # only half of the 1st alternative
    assert_equal 401, last_response.status
  end

  def test_favorite_widget_or_auth_alternatives
    post "/widgets/w1/favorite", {}, { "HTTP_X_API_KEY" => "key1" }
    assert_equal 204, last_response.status
  end
end

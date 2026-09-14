require_relative "concern_test_helper"
require "rack/test/uploaded_file"
require "json"

# controllerMode=concern's counterpart to controller_test.rb - same generated
# runtime.rb/lib/operations.js logic underneath (already exercised exhaustively over there), so
# this focuses on what's actually DIFFERENT about this mode: routing resolves to an ordinarily-
# autoloaded PetsController (not a generated one), `on_*` delegation works, and the concern's own
# `rescue_from` mapping (422/401) works the same way it does when it's baked into a fully
# generated controller.
class ConcernControllerTest < Minitest::Test
  include Rack::Test::Methods

  def app
    CONCERN_ROUTES
  end

  def setup
    PetsController.pets = { 1 => PetsController::Pet.new(1, "Rex", "dog", nil, "available", nil, nil, nil) }
    PetsController.next_id = 2
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
  end

  def test_array_query_parameter_and_cookie_still_work_the_same_way
    original = PetsController.instance_method(:on_list_pets)
    seen_tags = nil
    seen_cookie = nil
    PetsController.define_method(:on_list_pets) do |limit: nil, tag: nil, tags: nil, session_id: nil|
      seen_tags = tags
      seen_cookie = session_id
      KitchensinkConcern::Pets.from_h([])
    end
    get "/pets?tags=a&tags=b", {}, { "HTTP_COOKIE" => "session_id=abc123" }
    assert_equal 200, last_response.status
    assert_equal ["a", "b"], seen_tags
    assert_equal "abc123", seen_cookie
  ensure
    PetsController.define_method(:on_list_pets, original)
  end

  def test_multipart_file_upload
    file = Rack::Test::UploadedFile.new(StringIO.new("binarydata"), "image/jpeg", true, original_filename: "rex.jpg")
    post "/pets/1/photo", { caption: "Rex at the park", photo: file }
    assert_equal 204, last_response.status
  end
end

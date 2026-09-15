require_relative "test_helper"
require_relative "concern_test_helper"
require "json"

# Exercises the opt-in publishOpenApiSpec feature: both test_helper.rb's Kitchensink (generated
# mode) and concern_test_helper.rb's KitchensinkConcern (concern mode) were regenerated with
# publishOpenApiSpec=true (see ../Rakefile), so GET /openapi.json should be wired up on both
# ROUTES sets identically. generated_no_spec/ (Rakefile's :generate_no_spec) was regenerated with
# the var left unset, to confirm the feature is genuinely off by default.
class OpenApiSpecControllerTest < Minitest::Test
  include Rack::Test::Methods

  def app
    ROUTES
  end

  def test_serves_the_effective_openapi_document
    get "/openapi.json"
    assert_equal 200, last_response.status
    assert_includes last_response.content_type, "application/json"

    doc = JSON.parse(last_response.body)
    assert_match(/\A3\./, doc["openapi"])
    assert_includes doc["paths"].keys, "/pets"
    assert_includes doc["paths"].keys, "/pets/{petId}"
  end

  def test_serves_the_same_document_in_concern_mode
    response = Rack::MockRequest.new(CONCERN_ROUTES).get("/openapi.json")
    assert_equal 200, response.status
    assert_includes response.content_type, "application/json"
    doc = JSON.parse(response.body)
    assert_match(/\A3\./, doc["openapi"])
  end

  def test_publish_openapi_spec_is_off_by_default
    no_spec_dir = File.expand_path("../generated_no_spec", __dir__)
    refute File.exist?(File.join(no_spec_dir, "kitchensink_no_spec", "openapi.json")),
           "openapi.json should not be generated when publishOpenApiSpec is left unset"
    refute File.exist?(File.join(no_spec_dir, "kitchensink_no_spec", "controllers", "openapi_spec_controller.rb")),
           "OpenApiSpecController should not be generated when publishOpenApiSpec is left unset"
    routes_content = File.read(File.join(no_spec_dir, "kitchensink_no_spec", "routes.rb"))
    refute_match(/openapi\.json|OpenApiSpecController/, routes_content)
  end
end

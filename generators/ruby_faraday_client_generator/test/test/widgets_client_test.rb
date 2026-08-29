require_relative "test_helper"

# Security-focused end-to-end tests for WidgetsClient, over Faraday::Adapter::Test - see
# ClientTest for the shared stubbed_connection helper and general style. Kept in a separate file
# since these are all about favorite_widget/archive_widget's OR/AND security requirements, not
# general request/response shape.
class WidgetsClientTest < Minitest::Test
  def stubbed_connection
    stubs = Faraday::Adapter::Test::Stubs.new
    yield stubs
    conn = Faraday.new { |f| f.adapter :test, stubs }
    [conn, stubs]
  end

  # Wired from the spec's `security: [{oauth2Auth: [...]}, {apiKeyAuth: []}]` on this operation -
  # an OR-alternative requirement where oauth2Auth is treated identically to a plain bearer token
  # (RFC 6750), and apply_auth (runtime.rb) picks whichever alternative is fully configured.
  def test_favorite_widget_uses_the_bearer_alternative_when_only_a_bearer_token_is_configured
    conn, stubs = stubbed_connection do |stub|
      stub.post("/widgets/1/favorite") do |env|
        assert_equal "Bearer oauth2-token", env.request_headers["Authorization"]
        [204, {}, ""]
      end
    end
    api = Kitchensink::WidgetsClient.new(connection: conn, auth: { bearer: "oauth2-token" })

    api.favorite_widget(widget_id: "1")

    stubs.verify_stubbed_calls
  end

  def test_favorite_widget_uses_the_api_key_alternative_when_only_an_api_key_is_configured
    conn, stubs = stubbed_connection do |stub|
      stub.post("/widgets/1/favorite") do |env|
        assert_equal "my-api-key", env.request_headers["X-Api-Key"]
        refute env.request_headers.key?("Authorization")
        [204, {}, ""]
      end
    end
    api = Kitchensink::WidgetsClient.new(connection: conn, auth: { api_key: "my-api-key" })

    api.favorite_widget(widget_id: "1")

    stubs.verify_stubbed_calls
  end

  def test_favorite_widget_raises_when_neither_alternatives_credential_is_configured
    conn, _stubs = stubbed_connection { |_stub| }
    api = Kitchensink::WidgetsClient.new(connection: conn)

    error = assert_raises(ArgumentError) { api.favorite_widget(widget_id: "1") }
    assert_match(/auth\[:bearer\]/, error.message)
    assert_match(/auth\[:api_key\]/, error.message)
  end

  # Wired from `security: [{oauth2Auth: [...], apiKeyAuth: []}, {bearerAuth: []}]` - an
  # AND-within-OR requirement: either (oauth2Auth AND apiKeyAuth together) OR bearerAuth alone.
  def test_archive_widget_uses_the_bearer_alone_alternative_when_only_a_bearer_token_is_configured
    conn, stubs = stubbed_connection do |stub|
      stub.post("/widgets/1/archive") do |env|
        assert_equal "Bearer secret-token", env.request_headers["Authorization"]
        refute env.request_headers.key?("X-Api-Key")
        [204, {}, ""]
      end
    end
    api = Kitchensink::WidgetsClient.new(connection: conn, auth: { bearer: "secret-token" })

    api.archive_widget(widget_id: "1")

    stubs.verify_stubbed_calls
  end

  # AuthProvider has a single `bearer` slot shared by both oauth2Auth and bearerAuth (there's no
  # way to tell them apart at the config level), so when both `bearer` and `api_key` are
  # configured, the FIRST fully-satisfied alternative wins: the combined oauth2Auth+apiKeyAuth one
  # (declared first in the spec), not the bearerAuth-alone one.
  def test_archive_widget_picks_the_first_fully_satisfied_alternative_when_both_credentials_are_configured
    conn, stubs = stubbed_connection do |stub|
      stub.post("/widgets/1/archive") do |env|
        assert_equal "Bearer oauth2-token", env.request_headers["Authorization"]
        assert_equal "my-api-key", env.request_headers["X-Api-Key"]
        [204, {}, ""]
      end
    end
    api = Kitchensink::WidgetsClient.new(connection: conn, auth: { bearer: "oauth2-token", api_key: "my-api-key" })

    api.archive_widget(widget_id: "1")

    stubs.verify_stubbed_calls
  end

  def test_archive_widget_raises_when_only_an_api_key_is_configured
    conn, _stubs = stubbed_connection { |_stub| }
    api = Kitchensink::WidgetsClient.new(connection: conn, auth: { api_key: "my-api-key" })

    assert_raises(ArgumentError) { api.archive_widget(widget_id: "1") }
  end
end

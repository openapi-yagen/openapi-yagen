require_relative "test_helper"

# Unit tests for Kitchensink::Runtime itself (query/path escaping, auth application) - kept
# separate from HTTP-level ClientTest so the trickier serialization rules (array/deepObject query
# params) are asserted directly against our own code rather than through Faraday's own stub-path
# matcher, which has its own (irrelevant-to-us) opinions about query-string matching.
class RuntimeTest < Minitest::Test
  def test_resolve_request_path_preserves_a_configured_connections_own_base_path
    conn = Faraday.new(url: "https://api.example.com/v1")
    assert_equal "https://api.example.com/v1/pets", Kitchensink::Runtime.resolve_request_path(conn, "/pets")
  end

  def test_resolve_request_path_is_unaffected_by_a_root_only_base
    conn = Faraday.new(url: "https://api.example.com")
    assert_equal "https://api.example.com/pets", Kitchensink::Runtime.resolve_request_path(conn, "/pets")
  end

  # The pattern every other test in this suite uses for a Faraday::Adapter::Test-only connection
  # (no `url:` at all) - `url_prefix.host` is nil and `url_prefix.to_s` is a degenerate "http:/"
  # placeholder, so `path` must be returned unchanged rather than concatenated onto it (which
  # would produce a broken, doubly-prefixed URL once Faraday re-merges it).
  def test_resolve_request_path_leaves_a_bare_test_adapter_connection_unchanged
    conn = Faraday.new { |f| f.adapter :test, Faraday::Adapter::Test::Stubs.new }
    assert_equal "/pets", Kitchensink::Runtime.resolve_request_path(conn, "/pets")
  end

  def test_build_query_skips_nil_and_repeats_array_values
    qs = Kitchensink::Runtime.build_query("tag" => "dog", "limit" => nil, "tags" => ["a", "b"])
    assert_equal "tag=dog&tags=a&tags=b", qs
  end

  def test_build_query_deep_object_skips_nil_subvalues
    qs = Kitchensink::Runtime.build_query("created" => { "gte" => 100, "lte" => nil })
    assert_equal "created%5Bgte%5D=100", qs
  end

  def test_build_query_empty
    assert_equal "", Kitchensink::Runtime.build_query(nil)
    assert_equal "", Kitchensink::Runtime.build_query({})
  end

  def test_escape_path_segment_percent_encodes_reserved_characters
    assert_equal "a%20b%2Fc", Kitchensink::Runtime.escape_path_segment("a b/c")
    assert_equal "abc-_.~123", Kitchensink::Runtime.escape_path_segment("abc-_.~123")
  end

  def test_build_cookie_header_joins_pairs_and_skips_nil
    header = Kitchensink::Runtime.build_cookie_header("session_id" => "abc", "theme" => nil, "lang" => "en")
    assert_equal "session_id=abc; lang=en", header
  end

  def test_build_cookie_header_returns_nil_when_empty
    assert_nil Kitchensink::Runtime.build_cookie_header(nil)
    assert_nil Kitchensink::Runtime.build_cookie_header({})
  end

  # `auth:` is now always an Array of OR-alternatives, each an Array of AND-combined requirement
  # Hashes (see operations.js's buildAuthLiteral) - a single-scheme operation is just the
  # one-alternative/one-scheme case of this same uniform shape.
  def test_apply_auth_bearer_sets_authorization_header
    headers = {}
    query = Kitchensink::Runtime.apply_auth([[{ kind: :bearer }]], { bearer: -> { "tok123" } }, headers, nil, {})
    assert_equal "Bearer tok123", headers["Authorization"]
    assert_nil query
  end

  def test_apply_auth_api_key_in_query
    headers = {}
    query = Kitchensink::Runtime.apply_auth([[{ kind: :api_key, location: :query, name: "api_key" }]], { api_key: "abc" }, headers, {}, {})
    assert_equal({ "api_key" => "abc" }, query)
    assert_empty headers
  end

  def test_apply_auth_api_key_in_header
    headers = {}
    Kitchensink::Runtime.apply_auth([[{ kind: :api_key, location: :header, name: "X-Api-Key" }]], { api_key: "abc" }, headers, nil, {})
    assert_equal "abc", headers["X-Api-Key"]
  end

  def test_apply_auth_api_key_in_cookie
    cookies = {}
    Kitchensink::Runtime.apply_auth([[{ kind: :api_key, location: :cookie, name: "session_id" }]], { api_key: "abc" }, {}, nil, cookies)
    assert_equal({ "session_id" => "abc" }, cookies)
  end

  def test_apply_auth_missing_provider_raises
    assert_raises(ArgumentError) { Kitchensink::Runtime.apply_auth([[{ kind: :bearer }]], {}, {}, nil, {}) }
  end

  def test_apply_auth_no_requirement_passes_query_through_unchanged
    query = { "a" => 1 }
    assert_same query, Kitchensink::Runtime.apply_auth(nil, {}, {}, query, {})
    assert_same query, Kitchensink::Runtime.apply_auth([], {}, {}, query, {})
  end

  # OR-alternatives: the first alternative whose every scheme has a configured provider wins,
  # tried in declared order - see runtime.rb's apply_auth.
  def test_apply_auth_or_alternative_uses_the_first_fully_satisfied_one
    headers = {}
    alternatives = [[{ kind: :bearer }], [{ kind: :api_key, location: :header, name: "X-Api-Key" }]]
    Kitchensink::Runtime.apply_auth(alternatives, { api_key: "abc" }, headers, nil, {})
    assert_equal "abc", headers["X-Api-Key"]
    refute headers.key?("Authorization")
  end

  def test_apply_auth_or_alternative_raises_naming_every_alternative_when_none_are_satisfied
    alternatives = [[{ kind: :bearer }], [{ kind: :api_key, location: :header, name: "X-Api-Key" }]]
    error = assert_raises(ArgumentError) { Kitchensink::Runtime.apply_auth(alternatives, {}, {}, nil, {}) }
    assert_match(/auth\[:bearer\]/, error.message)
    assert_match(/auth\[:api_key\]/, error.message)
  end

  # AND-within-OR: an alternative with more than one scheme needs every one of them satisfied
  # together, all applied at once.
  def test_apply_auth_and_within_or_applies_every_scheme_in_the_matched_alternative
    headers = {}
    alternatives = [[{ kind: :bearer }, { kind: :api_key, location: :header, name: "X-Api-Key" }]]
    Kitchensink::Runtime.apply_auth(alternatives, { bearer: "tok", api_key: "key" }, headers, nil, {})
    assert_equal "Bearer tok", headers["Authorization"]
    assert_equal "key", headers["X-Api-Key"]
  end
end

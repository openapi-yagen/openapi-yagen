require_relative "test_helper"

# Unit tests for OpenapiYagenRuntime itself (query/path escaping, auth application) - kept
# separate from HTTP-level ClientTest so the trickier serialization rules (array/deepObject query
# params) are asserted directly against our own code rather than through Faraday's own stub-path
# matcher, which has its own (irrelevant-to-us) opinions about query-string matching.
class RuntimeTest < Minitest::Test
  def test_build_query_skips_nil_and_repeats_array_values
    qs = OpenapiYagenRuntime.build_query("tag" => "dog", "limit" => nil, "tags" => ["a", "b"])
    assert_equal "tag=dog&tags=a&tags=b", qs
  end

  def test_build_query_deep_object_skips_nil_subvalues
    qs = OpenapiYagenRuntime.build_query("created" => { "gte" => 100, "lte" => nil })
    assert_equal "created%5Bgte%5D=100", qs
  end

  def test_build_query_empty
    assert_equal "", OpenapiYagenRuntime.build_query(nil)
    assert_equal "", OpenapiYagenRuntime.build_query({})
  end

  def test_escape_path_segment_percent_encodes_reserved_characters
    assert_equal "a%20b%2Fc", OpenapiYagenRuntime.escape_path_segment("a b/c")
    assert_equal "abc-_.~123", OpenapiYagenRuntime.escape_path_segment("abc-_.~123")
  end

  def test_apply_auth_bearer_sets_authorization_header
    headers = {}
    query = OpenapiYagenRuntime.apply_auth({ kind: :bearer }, { bearer: -> { "tok123" } }, headers, nil)
    assert_equal "Bearer tok123", headers["Authorization"]
    assert_nil query
  end

  def test_apply_auth_api_key_in_query
    headers = {}
    query = OpenapiYagenRuntime.apply_auth({ kind: :api_key, location: :query, name: "api_key" }, { api_key: "abc" }, headers, {})
    assert_equal({ "api_key" => "abc" }, query)
    assert_empty headers
  end

  def test_apply_auth_api_key_in_header
    headers = {}
    OpenapiYagenRuntime.apply_auth({ kind: :api_key, location: :header, name: "X-Api-Key" }, { api_key: "abc" }, headers, nil)
    assert_equal "abc", headers["X-Api-Key"]
  end

  def test_apply_auth_missing_provider_raises
    assert_raises(ArgumentError) { OpenapiYagenRuntime.apply_auth({ kind: :bearer }, {}, {}, nil) }
  end

  def test_apply_auth_no_requirement_passes_query_through_unchanged
    query = { "a" => 1 }
    assert_same query, OpenapiYagenRuntime.apply_auth(nil, {}, {}, query)
  end
end

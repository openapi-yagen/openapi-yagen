require_relative "test_helper"
require "date"
require "time"
require "stringio"

class RuntimeTest < Minitest::Test
  def test_require_type_raises_validation_error_not_type_error
    # Deliberately ValidationError (not TypeError, unlike ruby_faraday_client_generator's own
    # runtime.rb) - see runtime.rb's header comment: a server-side check maps uniformly to a 422,
    # so every constraint/type-check helper here raises the same error class.
    assert_raises(OpenapiYagenRuntime::ValidationError) { OpenapiYagenRuntime.require_type("x", Integer, "n") }
    OpenapiYagenRuntime.require_type(1, Integer, "n") # doesn't raise
    OpenapiYagenRuntime.require_type(nil, Integer, "n") # nil is always fine - the required check is separate
  end

  def test_require_uuid
    assert_raises(OpenapiYagenRuntime::ValidationError) { OpenapiYagenRuntime.require_uuid("not-a-uuid", "id") }
    OpenapiYagenRuntime.require_uuid("550e8400-e29b-41d4-a716-446655440000", "id") # doesn't raise
    OpenapiYagenRuntime.require_uuid(nil, "id") # doesn't raise
  end

  def test_parse_date
    assert_equal Date.new(2024, 3, 15), OpenapiYagenRuntime.parse_date("2024-03-15")
    assert_nil OpenapiYagenRuntime.parse_date(nil)
    assert_raises(OpenapiYagenRuntime::ValidationError) { OpenapiYagenRuntime.parse_date("not-a-date") }
  end

  def test_parse_datetime
    parsed = OpenapiYagenRuntime.parse_datetime("2024-03-15T10:30:00Z")
    assert_equal 2024, parsed.year
    assert_nil OpenapiYagenRuntime.parse_datetime(nil)
    assert_raises(OpenapiYagenRuntime::ValidationError) { OpenapiYagenRuntime.parse_datetime("not-a-datetime") }
  end

  def test_require_string_or_file_accepts_string_and_io_like_objects
    OpenapiYagenRuntime.require_string_or_file("bytes", "photo") # String
    OpenapiYagenRuntime.require_string_or_file(StringIO.new("bytes"), "photo") # responds to :read
    OpenapiYagenRuntime.require_string_or_file(nil, "photo") # nil is always fine
    assert_raises(OpenapiYagenRuntime::ValidationError) { OpenapiYagenRuntime.require_string_or_file(42, "photo") }
  end

  def test_parse_int
    assert_equal 42, OpenapiYagenRuntime.parse_int("42", "limit")
    assert_nil OpenapiYagenRuntime.parse_int(nil, "limit")
    assert_raises(OpenapiYagenRuntime::ValidationError) { OpenapiYagenRuntime.parse_int("abc", "limit") }
  end

  def test_parse_bool
    assert_equal true, OpenapiYagenRuntime.parse_bool("true", "flag")
    assert_equal false, OpenapiYagenRuntime.parse_bool("0", "flag")
    assert_raises(OpenapiYagenRuntime::ValidationError) { OpenapiYagenRuntime.parse_bool("nope", "flag") }
  end

  def test_require_param
    assert_equal "1", OpenapiYagenRuntime.require_param({ "id" => "1" }, "id")
    assert_raises(OpenapiYagenRuntime::ValidationError) { OpenapiYagenRuntime.require_param({}, "id") }
  end
end

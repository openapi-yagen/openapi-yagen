require_relative "test_helper"
require "date"
require "time"
require "stringio"

class RuntimeTest < Minitest::Test
  def test_require_type_raises_validation_error_not_type_error
    # Deliberately ValidationError (not TypeError, unlike ruby_faraday_client_generator's own
    # runtime.rb) - see runtime.rb's header comment: a server-side check maps uniformly to a 422,
    # so every constraint/type-check helper here raises the same error class.
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Runtime.require_type("x", Integer, "n") }
    Kitchensink::Runtime.require_type(1, Integer, "n") # doesn't raise
    Kitchensink::Runtime.require_type(nil, Integer, "n") # nil is always fine - the required check is separate
  end

  def test_require_uuid
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Runtime.require_uuid("not-a-uuid", "id") }
    Kitchensink::Runtime.require_uuid("550e8400-e29b-41d4-a716-446655440000", "id") # doesn't raise
    Kitchensink::Runtime.require_uuid(nil, "id") # doesn't raise
  end

  def test_parse_date
    assert_equal Date.new(2024, 3, 15), Kitchensink::Runtime.parse_date("2024-03-15")
    assert_nil Kitchensink::Runtime.parse_date(nil)
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Runtime.parse_date("not-a-date") }
  end

  def test_parse_datetime
    parsed = Kitchensink::Runtime.parse_datetime("2024-03-15T10:30:00Z")
    assert_equal 2024, parsed.year
    assert_nil Kitchensink::Runtime.parse_datetime(nil)
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Runtime.parse_datetime("not-a-datetime") }
  end

  def test_require_string_or_file_accepts_string_and_io_like_objects
    Kitchensink::Runtime.require_string_or_file("bytes", "photo") # String
    Kitchensink::Runtime.require_string_or_file(StringIO.new("bytes"), "photo") # responds to :read
    Kitchensink::Runtime.require_string_or_file(nil, "photo") # nil is always fine
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Runtime.require_string_or_file(42, "photo") }
  end

  def test_parse_int
    assert_equal 42, Kitchensink::Runtime.parse_int("42", "limit")
    assert_nil Kitchensink::Runtime.parse_int(nil, "limit")
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Runtime.parse_int("abc", "limit") }
  end

  def test_parse_bool
    assert_equal true, Kitchensink::Runtime.parse_bool("true", "flag")
    assert_equal false, Kitchensink::Runtime.parse_bool("0", "flag")
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Runtime.parse_bool("nope", "flag") }
  end

  def test_require_param
    assert_equal "1", Kitchensink::Runtime.require_param({ "id" => "1" }, "id")
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Runtime.require_param({}, "id") }
  end
end

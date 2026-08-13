require "minitest/autorun"
require "open3"
require "tmpdir"

# Proves -v validate=false genuinely removes the validation behavior (not just hides it) - see
# lib/serialization.js's buildValidateStatements and templates/model_class.rb.j2's generated
# validate!, gated by the `validate` generator variable (default "true" - see models_test.rb,
# generated with the default, for the on-by-default behavior this is the mirror image of).
class ValidateFlagTest < Minitest::Test
  OPENAPI_YAGEN = ENV["OPENAPI_YAGEN"] || File.expand_path("../../../../dist/openapi-yagen", __dir__)
  GENERATOR_SRC = File.expand_path("../../src", __dir__)
  SPEC_FILE = File.expand_path("../resources/kitchensink.yaml", __dir__)

  def test_validate_false_generates_no_validate_bang_and_skips_all_checks
    Dir.mktmpdir do |out_dir|
      _stdout, stderr, status = Open3.capture3(
        OPENAPI_YAGEN, "g", "-o", out_dir, "-g", GENERATOR_SRC, SPEC_FILE,
        "-v", "moduleName=NoValidate", "-v", "validate=false"
      )
      assert status.success?, "expected generation to succeed: #{stderr}"

      rating_source = File.read(File.join(out_dir, "no_validate", "models", "rating.rb"))
      refute_match(/def validate!/, rating_source)
      refute_match(/is_a\?\(self\)/, rating_source)

      require File.join(out_dir, "no_validate")

      # Both the numeric range (1..5) and the pattern ("^[a-z]+$") are violated - with validate
      # left on (see models_test.rb's default-on suite) both raise ArgumentError; here, neither
      # does, proving the opt-out actually disables the checks rather than just not calling them
      # from somewhere else.
      rating = NoValidate::Rating.new(score: 999, label: "NOT-lowercase-and-way-too-long-for-the-pattern")
      wire = NoValidate::Rating.to_wire(rating)
      assert_equal(999, wire["score"])
    end
  end
end

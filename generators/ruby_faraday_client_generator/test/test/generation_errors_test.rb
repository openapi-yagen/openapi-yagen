require "minitest/autorun"
require "open3"
require "tmpdir"

# Shells out to the openapi-yagen binary directly (not through the Rakefile's :generate task,
# which regenerates the *happy-path* kitchensink.yaml fixture under default strict=true) to prove
# an unsupported request-body content-type actually fails generation loudly instead of silently
# dropping the body - see resources/unsupported_content_type.yaml and lib/operations.js's
# pickBodyContent/buildRequestBody.
class GenerationErrorsTest < Minitest::Test
  OPENAPI_YAGEN = ENV["OPENAPI_YAGEN"] || File.expand_path("../../../../dist/openapi-yagen", __dir__)
  GENERATOR_SRC = File.expand_path("../../src", __dir__)
  SPEC_FILE = File.expand_path("../resources/unsupported_content_type.yaml", __dir__)

  def generate(out_dir, strict: nil)
    args = [OPENAPI_YAGEN, "g", "-o", out_dir, "-g", GENERATOR_SRC, SPEC_FILE, "-v", "moduleName=UnsupportedContentType"]
    args += ["-v", "strict=#{strict}"] unless strict.nil?
    Open3.capture3(*args)
  end

  def test_strict_mode_aborts_generation_with_a_clear_message
    Dir.mktmpdir do |out_dir|
      stdout, stderr, status = generate(out_dir)
      refute status.success?, "expected generation to fail in strict mode (default)"
      assert_match(%r{text/plain}, stdout + stderr)
    end
  end

  def test_permissive_mode_skips_the_operation_with_a_warning
    Dir.mktmpdir do |out_dir|
      stdout, stderr, status = generate(out_dir, strict: "false")
      assert status.success?, "expected generation to succeed under -v strict=false: #{stdout}\n#{stderr}"
      assert_match(/WARNING/, stdout + stderr)
      assert_match(%r{text/plain}, stdout + stderr)
      refute File.exist?(File.join(out_dir, "unsupported_content_type", "apis", "notes_client.rb")),
             "the only operation on the only tag was skipped, so no api client file should exist for it"
    end
  end
end

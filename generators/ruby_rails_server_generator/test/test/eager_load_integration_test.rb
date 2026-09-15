require "minitest/autorun"
require "open3"
require "tmpdir"

# Static checks on eager_load_integration.rb's content - see GENERATOR_ISSUES.md #4 and the
# generator's own README "Production (config.eager_load = true)" section for what this file is
# for. This can only check the file's content, not real Zeitwerk/eager_load boot behavior - that
# needs a full Rails::Application, which this generator's test suite deliberately doesn't depend
# on (see README "Try it").
class EagerLoadIntegrationTest < Minitest::Test
  OPENAPI_YAGEN = ENV["OPENAPI_YAGEN"] || File.expand_path("../../../../dist/openapi-yagen", __dir__)
  GENERATOR_SRC = File.expand_path("../../src", __dir__)
  SPEC_FILE = File.expand_path("../resources/kitchensink.yaml", __dir__)

  def test_generated_mode_with_default_base_controller_has_no_warm_up_line
    content = File.read(File.join(__dir__, "..", "generated", "kitchensink", "eager_load_integration.rb"))
    assert_match(/Rails\.application\.config\.to_prepare do/, content)
    assert_match(/require_relative "kitchensink"/, content)
    refute_match(/warms Zeitwerk/, content, "the default baseController (already loaded via actionpack) needs no warm-up line")
  end

  def test_concern_mode_has_no_warm_up_line
    content = File.read(File.join(__dir__, "..", "generated_concern", "kitchensink_concern", "eager_load_integration.rb"))
    assert_match(/Rails\.application\.config\.to_prepare do/, content)
    assert_match(/require_relative "kitchensink_concern"/, content)
    refute_match(/warms Zeitwerk/, content, "baseController has no effect in controllerMode=concern")
  end

  def test_custom_base_controller_gets_a_warm_up_line_before_the_require
    Dir.mktmpdir do |out_dir|
      args = [
        OPENAPI_YAGEN, "g", "-o", out_dir, "-g", GENERATOR_SRC, SPEC_FILE,
        "-v", "moduleName=WarmBase", "-v", "baseController=MyApp::ApiBaseController"
      ]
      _stdout, stderr, status = Open3.capture3(*args)
      assert status.success?, "generation failed: #{stderr}"

      content = File.read(File.join(out_dir, "warm_base", "eager_load_integration.rb"))
      warm_up_index = content.index("MyApp::ApiBaseController")
      require_index = content.index('require_relative "warm_base"')
      refute_nil warm_up_index, "expected a warm-up reference to the custom baseController"
      assert_operator warm_up_index, :<, require_index, "the warm-up reference must come before require_relative"
    end
  end
end

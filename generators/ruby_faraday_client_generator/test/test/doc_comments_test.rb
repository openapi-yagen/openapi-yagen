require "minitest/autorun"

# Asserts doc comments actually land in the generated source, for the class itself, each
# property, and the constructor - see AGENTS.md's "every generator must thread OpenAPI
# description into generated doc comments" convention and lib/types.js's registerClass
# (`initComment`) / templates/model_class.rb.j2. Reads the generated file's raw text directly
# (same approach the sibling generators' own doc-comment tests use) - Ruby has no runtime
# reflection over its own source comments the way, say, a compiled language's doc-comment
# extraction tooling might.
class DocCommentsTest < Minitest::Test
  PET_SOURCE = File.read(File.expand_path("../generated/kitchensink/models/pet.rb", __dir__))
  PETS_CLIENT_SOURCE = File.read(File.expand_path("../generated/kitchensink/apis/pets_client.rb", __dir__))
  WIDGETS_CLIENT_SOURCE = File.read(File.expand_path("../generated/kitchensink/apis/widgets_client.rb", __dir__))

  def test_class_gets_its_schema_description
    assert_match(/# A pet available in the store\.\n  class Pet/, PET_SOURCE)
  end

  def test_a_property_with_no_schema_description_still_gets_a_return_type_comment
    assert_match(/# @return \[Integer\]\n    attr_accessor :id/, PET_SOURCE)
  end

  def test_a_property_with_a_schema_description_gets_both
    assert_match(/# The pet's display name\.\n    # @return \[String\]\n    attr_accessor :name/, PET_SOURCE)
  end

  def test_initialize_gets_a_param_comment_per_property
    assert_match(/# @param id \[Integer\]/, PET_SOURCE)
    assert_match(/# @param name \[String\] The pet's display name\./, PET_SOURCE)
  end

  # Operation methods (see lib/operations.js's buildDocLines, ported from
  # ruby_rails_server_generator's own) - every parameter gets a real, specific YARD type (not just
  # a bare @param name the way the engine's native buildDocComment alone would render it), and the
  # method itself always gets an @return.
  def test_a_query_param_with_a_description_gets_a_typed_param_comment
    assert_match(/# @param limit \[Integer\] Maximum number of pets to return\./, PETS_CLIENT_SOURCE)
  end

  def test_a_query_param_with_no_description_still_gets_a_typed_param_comment
    assert_match(/# @param tag \[String\]\n/, PETS_CLIENT_SOURCE)
  end

  def test_an_array_typed_query_param_gets_an_array_item_type
    assert_match(/# @param tags \[Array<String>\]/, PETS_CLIENT_SOURCE)
  end

  def test_a_cookie_param_gets_a_typed_param_comment
    assert_match(/# @param session_id \[String\] Exercises a cookie parameter\./, PETS_CLIENT_SOURCE)
  end

  def test_the_body_param_gets_its_model_class_as_a_real_param_type_not_embedded_in_a_description
    assert_match(/# @param body \[NewPet\]\n    # @return \[Pet\]\n    def create_pet/, PETS_CLIENT_SOURCE)
  end

  def test_an_operation_with_no_response_body_gets_a_void_return_type
    assert_match(/# @return \[void\]\n    def delete_pet/, PETS_CLIENT_SOURCE)
  end

  def test_a_header_param_gets_a_typed_param_comment
    assert_match(/# @param x_client_version \[String\]\n/, WIDGETS_CLIENT_SOURCE)
  end

  def test_an_enum_typed_query_param_gets_its_generated_enum_class_as_a_real_param_type
    assert_match(/# @param status \[WidgetsClientListWidgetsStatus\] An enum-typed query parameter/, WIDGETS_CLIENT_SOURCE)
  end
end

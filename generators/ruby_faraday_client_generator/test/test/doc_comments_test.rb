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
end

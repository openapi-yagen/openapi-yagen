require "minitest/autorun"

# Asserts YARD doc comments actually land in the generated source, for the class itself, each
# property, and the constructor - see AGENTS.md's "every generator must thread OpenAPI description
# into generated doc comments" convention and lib/types.js's registerClass (`initComment`) /
# templates/model_class.rb.j2. Mirrors ruby_faraday_client_generator's own doc_comments_test.rb.
# Reads the generated file's raw text directly - Ruby has no runtime reflection over its own
# source comments the way, say, a compiled language's doc-comment extraction tooling might. This
# matters more here than for a client: RubyMine (and any other YARD-aware tool) uses these tags to
# type-check a handler's implementation against the generated handler-interface/model types.
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

  # Server-only additions (see model_class.rb.j2's fork) - a format:date/date-time property shows
  # its Ruby Date/Time type, not a plain String, and from_object/to_attributes get their own YARD
  # tags too.
  def test_date_and_datetime_properties_get_their_ruby_type_in_the_doc_comment
    assert_match(/# @return \[Date\]\n    attr_accessor :adopted_on/, PET_SOURCE)
    assert_match(/# @return \[Time\]\n    attr_accessor :last_seen_at/, PET_SOURCE)
  end

  def test_from_object_and_to_attributes_get_yard_tags
    assert_match(/# @param source \[Object\]\n    # @return \[Pet\]\n    def self\.from_object/, PET_SOURCE)
    assert_match(/# @return \[Hash\{Symbol=>Object\}\][^\n]*\n(?:[^\n]*\n)*?    def to_attributes/, PET_SOURCE)
  end
end

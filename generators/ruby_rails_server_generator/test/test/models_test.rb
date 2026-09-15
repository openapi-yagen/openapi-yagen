require_relative "test_helper"
require "date"
require "time"
require "ostruct"

class ModelsTest < Minitest::Test
  def test_pet_round_trip
    pet = Kitchensink::Pet.from_h("id" => 1, "name" => "Rex", "tag" => "dog", "status" => "available")
    assert_instance_of Kitchensink::Pet, pet
    assert_equal 1, pet.id
    assert_equal "Rex", pet.name
    assert_equal "dog", pet.tag
    assert_equal "available", pet.status

    wire = pet.to_h
    assert_equal({ "id" => 1, "name" => "Rex", "tag" => "dog", "status" => "available" }, wire)
  end

  def test_pet_optional_properties_omitted_from_wire
    pet = Kitchensink::Pet.from_h("id" => 1, "name" => "Rex")
    assert_nil pet.tag
    assert_nil pet.status
    assert_equal({ "id" => 1, "name" => "Rex" }, pet.to_h)
  end

  def test_pet_from_h_nil
    assert_nil Kitchensink::Pet.from_h(nil)
    assert_nil Kitchensink::Pet.to_wire(nil)
  end

  def test_pet_status_enum_validates
    assert_equal "available", Kitchensink::PetStatus.from_h("available")
    assert_equal Kitchensink::PetStatus::AVAILABLE, Kitchensink::PetStatus.from_h("available")
    assert_nil Kitchensink::PetStatus.from_h(nil)
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::PetStatus.from_h("extinct") }
  end

  def test_pets_array_of_refs
    pets = Kitchensink::Pets.from_h([{ "id" => 1, "name" => "Rex" }, { "id" => 2, "name" => "Fido" }])
    assert_equal 2, pets.length
    assert_kind_of Kitchensink::Pet, pets.first
    assert_equal [{ "id" => 1, "name" => "Rex" }, { "id" => 2, "name" => "Fido" }], Kitchensink::Pets.to_wire(pets)
  end

  def test_named_pet_all_of_merge
    named = Kitchensink::NamedPet.from_h("id" => 1, "name" => "Rex", "species" => "dog")
    assert_equal 1, named.id
    assert_equal "Rex", named.name
    assert_equal "dog", named.species
    assert_equal({ "id" => 1, "name" => "Rex", "species" => "dog" }, named.to_h)
  end

  def test_shape_discriminated_union
    circle = Kitchensink::Shape.from_h("shapeType" => "circle", "radius" => 2.5)
    assert_instance_of Kitchensink::Circle, circle
    assert_in_delta 2.5, circle.radius, 0.0001

    square = Kitchensink::Shape.from_h("shapeType" => "square", "side" => 3)
    assert_instance_of Kitchensink::Square, square

    assert_equal({ "shapeType" => "circle", "radius" => 2.5 }, Kitchensink::Shape.to_wire(circle))
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Shape.from_h("shapeType" => "triangle") }
  end

  def test_widget_variant_undiscriminated_union_object_with_kind
    variant = Kitchensink::WidgetVariant.from_h("kind" => "size", "value" => 42)
    assert_instance_of Kitchensink::WidgetVariantA, variant
    assert_equal 42, variant.value
    assert_equal({ "kind" => "size", "value" => 42 }, Kitchensink::WidgetVariant.to_wire(variant))
  end

  def test_widget_variant_undiscriminated_union_object_with_label
    variant = Kitchensink::WidgetVariant.from_h("label" => "large")
    assert_instance_of Kitchensink::WidgetVariantB, variant
    assert_equal "large", variant.label
  end

  def test_widget_variant_undiscriminated_union_string_fallback
    variant = Kitchensink::WidgetVariant.from_h("compact")
    assert_equal "compact", variant
    assert_equal "compact", Kitchensink::WidgetVariant.to_wire(variant)
  end

  def test_widget_variant_no_match_raises
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::WidgetVariant.from_h(42) }
  end

  # EnvelopeUnion's 3 variants share the exact same top-level properties (meta + payload) and
  # differ only in the nested shape of payload - resolveUnionDispatch can't tell them apart, so
  # this must fall back to an untyped passthrough instead of failing generation.
  def test_envelope_union_falls_back_to_untyped_value
    raw = { "meta" => { "code" => 1 }, "payload" => %w[a b] }
    value = Kitchensink::EnvelopeUnion.from_h(raw)
    assert_equal raw, value
    assert_equal raw, Kitchensink::EnvelopeUnion.to_wire(value)
  end

  # See AGENTS.md's "a generator for a dynamically-typed target language must generate its own
  # runtime checks" convention - this generator's reference implementation of it.
  def test_to_wire_raises_type_error_for_a_non_matching_object
    assert_raises(TypeError) { Kitchensink::NewPet.to_wire({ "name" => "Rex" }) }
  end

  # `default` support: a numeric/enum default applies to `initialize`'s own keyword-arg default
  # AND to from_h when the JSON key is absent - but NOT for an explicit JSON null, the same
  # "absent vs. explicit null" distinction the Go/Kotlin generators' own default handling
  # preserves (see types.js's buildDefaultLiteral).
  def test_new_pet_applies_its_defaults_when_constructed_directly
    pet = Kitchensink::NewPet.new(name: "Rex")
    assert_equal 1, pet.priority
    assert_equal "public", pet.visibility
  end

  def test_new_pet_applies_its_defaults_when_the_keys_are_absent_from_h
    pet = Kitchensink::NewPet.from_h("name" => "Rex")
    assert_equal 1, pet.priority
    assert_equal "public", pet.visibility
  end

  def test_new_pet_does_not_apply_its_default_when_the_key_is_explicitly_null
    pet = Kitchensink::NewPet.from_h("name" => "Rex", "priority" => nil, "visibility" => nil)
    assert_nil pet.priority
    assert_nil pet.visibility
  end

  def test_validate_bang_returns_self_for_a_conforming_instance
    pet = Kitchensink::NewPet.new(name: "Rex")
    assert_same pet, pet.validate!
  end

  def test_validate_bang_enforces_string_length_constraints
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::NewPet.new(name: "").validate! }
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::NewPet.new(name: "x" * 51).validate! }
  end

  def test_validate_bang_enforces_numeric_range_constraints
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Rating.new(score: 0, label: "ok").validate! }
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Rating.new(score: 6, label: "ok").validate! }
    Kitchensink::Rating.new(score: 3, label: "ok").validate! # doesn't raise
  end

  def test_validate_bang_enforces_pattern_constraints
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Rating.new(score: 3, label: "NOT-lowercase").validate! }
  end

  def test_validate_bang_enforces_enum_membership_on_a_property
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::NewPet.new(name: "Rex", status: "extinct").validate! }
    Kitchensink::NewPet.new(name: "Rex", status: "available").validate! # doesn't raise
  end

  def test_to_wire_calls_validate_bang_before_sending
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Rating.to_wire(Kitchensink::Rating.new(score: 9, label: "ok")) }
  end

  # Pet.id/.name declare no constraintsOf() keywords at all (no minLength/minimum/...) - without a
  # basic type check, validate! would do *nothing* for them, which looks exactly like validation
  # being broken rather than there being nothing to check (a real gap found via a user report:
  # `Pet.new(id: "abc", name: "Rex")` used to pass validate! silently).
  def test_validate_bang_enforces_basic_type_even_with_no_constraints_declared
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Pet.new(id: "not-an-integer", name: "Rex").validate! }
    Kitchensink::Pet.new(id: 1, name: "Rex").validate! # doesn't raise
  end

  # Ruby's own mandatory-keyword-argument mechanism only enforces that `id:`/`name:` are *passed*
  # to `new(...)`, not that their value isn't nil (`Pet.new(id: nil, name: "Rex")` is valid Ruby) -
  # validate! adds the presence check that actually makes "required" mean something.
  def test_validate_bang_enforces_required_properties_are_not_nil
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Pet.new(id: nil, name: "Rex").validate! }
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Pet.new(id: 1, name: nil).validate! }
  end

  # --- server-only additions: format:uuid/date/date-time (see lib/types.js and lib/serialization.js
  # forks) - not present in ruby_faraday_client_generator, this generator's reference tests for them.

  def test_pet_uuid_round_trip
    pet = Kitchensink::Pet.from_h("id" => 1, "name" => "Rex", "uuid" => "550e8400-e29b-41d4-a716-446655440000")
    assert_equal "550e8400-e29b-41d4-a716-446655440000", pet.uuid
    assert_equal "550e8400-e29b-41d4-a716-446655440000", pet.to_h["uuid"]
  end

  def test_pet_uuid_validation_rejects_a_malformed_value
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Pet.new(id: 1, name: "Rex", uuid: "not-a-uuid").validate! }
    Kitchensink::Pet.new(id: 1, name: "Rex", uuid: "550e8400-e29b-41d4-a716-446655440000").validate! # doesn't raise
  end

  def test_pet_date_property_parses_into_a_ruby_date
    pet = Kitchensink::Pet.from_h("id" => 1, "name" => "Rex", "adoptedOn" => "2024-03-15")
    assert_instance_of Date, pet.adopted_on
    assert_equal Date.new(2024, 3, 15), pet.adopted_on
    assert_equal "2024-03-15", pet.to_h["adoptedOn"]
  end

  def test_pet_date_from_h_rejects_a_malformed_value
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Pet.from_h("id" => 1, "name" => "Rex", "adoptedOn" => "not-a-date") }
  end

  def test_pet_date_validate_bang_enforces_basic_type
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Pet.new(id: 1, name: "Rex", adopted_on: "2024-03-15").validate! }
    Kitchensink::Pet.new(id: 1, name: "Rex", adopted_on: Date.new(2024, 3, 15)).validate! # doesn't raise
  end

  def test_pet_datetime_property_parses_into_a_ruby_time
    pet = Kitchensink::Pet.from_h("id" => 1, "name" => "Rex", "lastSeenAt" => "2024-03-15T10:30:00Z")
    assert_instance_of Time, pet.last_seen_at
    assert_equal "2024-03-15T10:30:00Z", pet.to_h["lastSeenAt"]
  end

  def test_pet_datetime_from_h_rejects_a_malformed_value
    assert_raises(Kitchensink::Runtime::ValidationError) { Kitchensink::Pet.from_h("id" => 1, "name" => "Rex", "lastSeenAt" => "not-a-datetime") }
  end

  # --- server-only additions: from_object/to_attributes DTO <-> application-model mapping.

  def test_from_object_reads_matching_accessors
    source = OpenStruct.new(id: 1, name: "Rex", tag: "dog", notes: nil, status: "available", uuid: nil, adopted_on: nil, last_seen_at: nil)
    pet = Kitchensink::Pet.from_object(source)
    assert_instance_of Kitchensink::Pet, pet
    assert_equal 1, pet.id
    assert_equal "Rex", pet.name
    assert_equal "dog", pet.tag
    assert_equal "available", pet.status
  end

  def test_from_object_raises_when_source_lacks_a_matching_accessor
    # Unlike OpenStruct (which answers any getter with nil, set or not), a Struct only defines the
    # accessors it's given - `.name` genuinely doesn't exist here, so this is a real NoMethodError,
    # not a silently-nil field.
    source = Struct.new(:id).new(1)
    assert_raises(NoMethodError) { Kitchensink::Pet.from_object(source) }
  end

  def test_to_attributes_uses_ruby_attribute_names_not_wire_names
    pet = Kitchensink::Pet.from_h("id" => 1, "name" => "Rex", "tag" => "dog")
    expected = { adopted_on: nil, id: 1, last_seen_at: nil, name: "Rex", notes: nil, status: nil, tag: "dog", uuid: nil }
    assert_equal expected, pet.to_attributes
  end
end

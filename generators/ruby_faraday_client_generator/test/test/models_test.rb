require_relative "test_helper"

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
    assert_raises(ArgumentError) { Kitchensink::PetStatus.from_h("extinct") }
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
    assert_raises(ArgumentError) { Kitchensink::Shape.from_h("shapeType" => "triangle") }
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
    assert_raises(ArgumentError) { Kitchensink::WidgetVariant.from_h(42) }
  end

  # See AGENTS.md's "a generator for a dynamically-typed target language must generate its own
  # runtime checks" convention - this generator's reference implementation of it.
  def test_to_wire_raises_type_error_for_a_non_matching_object
    assert_raises(TypeError) { Kitchensink::NewPet.to_wire({ "name" => "Rex" }) }
  end

  def test_validate_bang_returns_self_for_a_conforming_instance
    pet = Kitchensink::NewPet.new(name: "Rex")
    assert_same pet, pet.validate!
  end

  def test_validate_bang_enforces_string_length_constraints
    assert_raises(ArgumentError) { Kitchensink::NewPet.new(name: "").validate! }
    assert_raises(ArgumentError) { Kitchensink::NewPet.new(name: "x" * 51).validate! }
  end

  def test_validate_bang_enforces_numeric_range_constraints
    assert_raises(ArgumentError) { Kitchensink::Rating.new(score: 0, label: "ok").validate! }
    assert_raises(ArgumentError) { Kitchensink::Rating.new(score: 6, label: "ok").validate! }
    Kitchensink::Rating.new(score: 3, label: "ok").validate! # doesn't raise
  end

  def test_validate_bang_enforces_pattern_constraints
    assert_raises(ArgumentError) { Kitchensink::Rating.new(score: 3, label: "NOT-lowercase").validate! }
  end

  def test_validate_bang_enforces_enum_membership_on_a_property
    assert_raises(ArgumentError) { Kitchensink::NewPet.new(name: "Rex", status: "extinct").validate! }
    Kitchensink::NewPet.new(name: "Rex", status: "available").validate! # doesn't raise
  end

  def test_to_wire_calls_validate_bang_before_sending
    assert_raises(ArgumentError) { Kitchensink::Rating.to_wire(Kitchensink::Rating.new(score: 9, label: "ok")) }
  end

  # Pet.id/.name declare no constraintsOf() keywords at all (no minLength/minimum/...) - without a
  # basic type check, validate! would do *nothing* for them, which looks exactly like validation
  # being broken rather than there being nothing to check (a real gap found via a user report:
  # `Pet.new(id: "abc", name: "Rex")` used to pass validate! silently).
  def test_validate_bang_enforces_basic_type_even_with_no_constraints_declared
    assert_raises(TypeError) { Kitchensink::Pet.new(id: "not-an-integer", name: "Rex").validate! }
    Kitchensink::Pet.new(id: 1, name: "Rex").validate! # doesn't raise
  end

  # Ruby's own mandatory-keyword-argument mechanism only enforces that `id:`/`name:` are *passed*
  # to `new(...)`, not that their value isn't nil (`Pet.new(id: nil, name: "Rex")` is valid Ruby) -
  # validate! adds the presence check that actually makes "required" mean something.
  def test_validate_bang_enforces_required_properties_are_not_nil
    assert_raises(ArgumentError) { Kitchensink::Pet.new(id: nil, name: "Rex").validate! }
    assert_raises(ArgumentError) { Kitchensink::Pet.new(id: 1, name: nil).validate! }
  end
end

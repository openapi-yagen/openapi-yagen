require "minitest/autorun"
require "action_controller"
require "action_controller/api"
require "rack/test"
require_relative "../generated_concern/kitchensink_concern"

# Same idea as test_helper.rb, but for controllerMode=concern: here WE write the controller (the
# thing a real app's app/controllers/ would contain), `include`-ing the generated concern and
# implementing its `on_*` methods - there is no separate handler object/registry in this mode.
#
# A real ActionController is instantiated fresh per request by Rails, so per-request instance
# state doesn't persist between calls - `@pets` lives on the class itself instead (a stand-in for
# what a real app would keep in ActiveRecord/a database), reset in setup (see
# concern_controller_test.rb) the same way test_helper.rb's FakePetsHandler is a single
# long-lived object there.
class PetsController < ActionController::API
  include KitchensinkConcern::PetsController

  Pet = Struct.new(:id, :name, :tag, :notes, :status, :uuid, :adopted_on, :last_seen_at)

  class << self
    attr_accessor :pets, :next_id
  end

  def on_list_pets(limit: nil, tag: nil, tags: nil, session_id: nil)
    KitchensinkConcern::Pets.from_h(self.class.pets.values.map { |p| { "id" => p.id, "name" => p.name, "tag" => p.tag, "status" => p.status } })
  end

  def on_create_pet(body:)
    pet = Pet.new(self.class.next_id, body.name, body.tag, body.notes, body.status, nil, nil, nil)
    self.class.next_id += 1
    self.class.pets[pet.id] = pet
    KitchensinkConcern::Pet.from_object(pet)
  end

  def on_get_pet_by_id(pet_id:)
    pet = self.class.pets.fetch(pet_id.to_i) { raise "not found" }
    KitchensinkConcern::Pet.from_object(pet)
  end

  def on_delete_pet(pet_id:, bearer_auth:)
    self.class.pets.delete(pet_id.to_i)
    nil
  end

  def on_upload_pet_avatar(pet_id:, body:)
    body
  end

  def on_get_named_tag(pet_id:)
    KitchensinkConcern::NamedPet.new(id: pet_id.to_i, name: "Rex", species: "dog")
  end

  def on_set_pet_notes(pet_id:, body:)
    body
  end

  def on_upload_pet_photo(pet_id:, body:)
    nil
  end

  def on_rate_pet(pet_id:, x_request_id:, api_key_auth:, body:)
    nil
  end

  def on_subscribe_to_pet(pet_id:, body:)
    nil
  end
end

CONCERN_ROUTES = ActionDispatch::Routing::RouteSet.new
CONCERN_ROUTES.draw do
  KitchensinkConcern::Routes.draw(self)
end

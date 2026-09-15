import { buildModelRegistry } from "./lib/types.js";
import { collectOperationsByTag } from "./lib/operations.js";

const moduleName = vars.moduleName;
const moduleSnake = toSnakeCase(moduleName);
// See AGENTS.md's "a generator for a dynamically-typed target language must generate its own
// runtime checks" convention - Ruby has no compiler to reject a wrong-shaped value the way the
// TypeScript/Kotlin generators' static types do, so this generator's substitute (a type check
// plus generated constraint validation, see lib/serialization.js's buildValidateStatements and
// templates/model_class.rb.j2) is opt-out rather than a fixed behavior. Unlike
// ruby_faraday_client_generator, this is load-bearing on a server (untrusted client input), not
// just a nice-to-have - see the generator.yml description.
const validate = vars.validate !== "false";
// "generated" (default): a full controller per tag, dispatching to a registered handler object -
// see templates/controller.rb.j2/handlers.rb.j2. "concern": an ActiveSupport::Concern the caller
// includes into their own hand-written controller - see templates/controller_concern.rb.j2.
const controllerMode = vars.controllerMode || "generated";
if (controllerMode !== "generated" && controllerMode !== "concern") {
  throw Error(`<6e40a11a> Unsupported controllerMode "${controllerMode}" - only "generated" or "concern" are supported`);
}
const baseController = vars.baseController || "ActionController::API";
const publishOpenApiSpec = vars.publishOpenApiSpec === "true";
const openApiSpecPath = vars.openApiSpecPath || "/openapi.json";

const registry = buildModelRegistry(schema);
// May register additional inline models discovered only in operation bodies/responses - must run
// before rendering models below so nothing is missed (same ordering requirement as
// ruby_faraday_client_generator's own main.js).
const groups = collectOperationsByTag(registry);

const MODEL_TEMPLATES = {
  class: "templates/model_class.rb.j2",
  enum: "templates/model_enum.rb.j2",
  union_discriminated: "templates/model_union.rb.j2",
  union_dispatch: "templates/model_union.rb.j2",
  alias: "templates/model_alias.rb.j2",
};

for (const name of registry.order) {
  const model = registry.models.get(name);
  const tmpl = MODEL_TEMPLATES[model.kind];
  if (!tmpl) throw Error(`<856c7d77> Unknown model kind: ${model.kind}`);
  const fileName = toSnakeCase(name);
  renderTemplate(tmpl, { moduleName, model, validate }, `${moduleSnake}/models/${fileName}.rb`);
}

const tagGroups = [];
for (const [, group] of groups) {
  if (controllerMode === "generated") {
    renderTemplate(
      "templates/handlers.rb.j2",
      { moduleName, group },
      `${moduleSnake}/controllers/${group.fileBase}_handler_interface.rb`
    );
    renderTemplate(
      "templates/controller.rb.j2",
      { moduleName, group, baseController },
      `${moduleSnake}/controllers/${group.fileBase}_controller.rb`
    );
  } else {
    renderTemplate(
      "templates/controller_concern.rb.j2",
      { moduleName, group },
      `${moduleSnake}/controllers/${group.fileBase}_controller_concern.rb`
    );
  }
  tagGroups.push(group);
}
if (publishOpenApiSpec) {
  writeFile(`${moduleSnake}/openapi.json`, openApiSpecJson);
  renderTemplate(
    "templates/openapi_spec_controller.rb.j2",
    { moduleName, baseController },
    `${moduleSnake}/controllers/openapi_spec_controller.rb`
  );
}
renderTemplate(
  "templates/routes.rb.j2",
  { moduleName, groups: tagGroups, controllerMode, publishOpenApiSpec, openApiSpecPath },
  `${moduleSnake}/routes.rb`
);

copyFile("runtime.rb", `${moduleSnake}/runtime.rb`);
renderTemplate(
  "templates/index.rb.j2",
  { moduleName, moduleSnake, models: registry.order.map((n) => toSnakeCase(n)), tagGroups, controllerMode, publishOpenApiSpec },
  `${moduleSnake}.rb`
);

dump(`Generated ${registry.order.length} model(s) and ${tagGroups.length} controller(s)`);

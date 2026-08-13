import { buildModelRegistry } from "./lib/types.js";
import { collectOperationsByTag } from "./lib/operations.js";

const moduleName = vars.moduleName;
const moduleSnake = toSnakeCase(moduleName);
// See AGENTS.md's "a generator for a dynamically-typed target language must generate its own
// runtime checks" convention - Ruby has no compiler to reject a wrong-shaped body the way the
// TypeScript/Kotlin generators' static types do, so this generator's substitute (a type check
// plus generated constraint validation, see lib/serialization.js's buildValidateStatements and
// templates/model_class.rb.j2) is opt-out rather than a fixed behavior.
const validate = vars.validate !== "false";

const registry = buildModelRegistry(schema);
// May register additional inline models discovered only in operation bodies/responses - must run
// before rendering models below so nothing is missed.
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
  if (!tmpl) throw Error(`<2a6e9c17> Unknown model kind: ${model.kind}`);
  const fileName = toSnakeCase(name);
  renderTemplate(tmpl, { moduleName, model, validate }, `${moduleSnake}/models/${fileName}.rb`);
}

const tagGroups = [];
for (const [, group] of groups) {
  const fileName = toSnakeCase(group.tagClass);
  renderTemplate(
    "templates/api_client.rb.j2",
    { moduleName, tagClass: group.tagClass, tagDescription: group.description, operations: group.operations },
    `${moduleSnake}/apis/${fileName}.rb`
  );
  tagGroups.push({ tagClass: group.tagClass, propertyName: group.propertyName, fileName });
}

// The document's own top-level description (info.description) - distinct from a tag's own
// description (group.description, already threaded onto each per-tag class) - is the only
// sensible source of doc text for the bundle class, since it represents the whole API, not any
// one tag.
const apiDescription = (schema.info && schema.info.description) || null;

copyFile("runtime.rb", `${moduleSnake}/runtime.rb`);
renderTemplate("templates/api_bundle.rb.j2", { moduleName, apiDescription, tagGroups }, `${moduleSnake}/api_client.rb`);
renderTemplate(
  "templates/index.rb.j2",
  { moduleSnake, models: registry.order.map((n) => toSnakeCase(n)), tagGroups },
  `${moduleSnake}.rb`
);

dump(`Generated ${registry.order.length} model(s) and ${groups.size} operation group(s)`);

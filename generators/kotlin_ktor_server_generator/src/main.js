import { buildModelRegistry, finalizeValidationCalls, configureDateTimeType } from "./lib/types.js";
import { collectOperationsByTag } from "./lib/operations.js";

const packageName = vars.packageName;
configureDateTimeType(vars.dateTimeType);

const GENERATE_MODES = ["all", "models", "api"];
const generate = vars.generate || "all";
if (!GENERATE_MODES.includes(generate)) {
  throw Error(`<4afc780d> Unsupported generate "${generate}"; expected one of ${GENERATE_MODES.join(", ")}`);
}

const registry = buildModelRegistry(schema);
// May register additional inline models discovered only in operation params/bodies/responses -
// must run before rendering models below so nothing is missed.
const groups = collectOperationsByTag(registry);
// Only now is every model's final registration state settled - see finalizeValidationCalls's own
// comment (lib/types.js) for why this can't run any earlier.
finalizeValidationCalls(registry);

const MODEL_TEMPLATES = {
  object: "templates/model_data_class.kt.j2",
  enum: "templates/model_enum.kt.j2",
  sealed: "templates/model_sealed.kt.j2",
  typealias: "templates/model_typealias.kt.j2",
  union: "templates/model_union.kt.j2",
};

if (generate !== "api") {
  for (const name of registry.order) {
    const model = registry.models.get(name);
    const tmpl = MODEL_TEMPLATES[model.kind];
    if (!tmpl) throw Error(`<158657ec> Unknown model kind: ${model.kind}`);
    renderTemplate(tmpl, { packageName, model }, `models/${name}.kt`);
  }
}

if (generate !== "models") {
  for (const [, group] of groups) {
    const data = { packageName, tagClass: group.tagClass, tagDescription: group.description, operations: group.operations };
    renderTemplate("templates/api_handler.kt.j2", data, `apis/${group.tagClass}Handler.kt`);
    renderTemplate("templates/api_routes.kt.j2", data, `apis/${group.tagClass}Routes.kt`);
  }

  renderTemplate("templates/validation.kt.j2", { packageName }, "Validation.kt");

  // Routes call .validate() (see api_routes.kt.j2's op.body.hasValidate) on whatever the body
  // model type turns out to be, whether or not this run also generated models/*.kt - so these
  // extensions always render alongside the routes/handlers, never alongside models/*.kt itself.
  const validatedModels = registry.order.map((name) => registry.models.get(name)).filter((model) => model.kind === "object");
  renderTemplate("templates/model_validation.kt.j2", { packageName, models: validatedModels }, "ModelValidation.kt");
}

dump(`Generated (mode: ${generate}) ${registry.order.length} model(s) and ${groups.size} operation group(s)`);

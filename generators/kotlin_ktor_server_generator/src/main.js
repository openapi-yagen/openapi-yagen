import { buildModelRegistry, finalizeValidationCalls, configureDateTimeType } from "./lib/types.js";
import { collectOperationsByTag } from "./lib/operations.js";

const packageName = vars.packageName;
const modelsPackage = `${packageName}.models`;
const apisPackage = `${packageName}.apis`;
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
    renderTemplate(tmpl, { packageName, modelsPackage, apisPackage, model }, `models/${name}.kt`);
  }
}

// A group's operations reference generated model types only as embedded identifiers inside
// already-formatted Kotlin type strings (signatureParams, response.type, param converters, ...) -
// rather than threading a parallel "which models does this operation touch" list through every
// shape in operations.js, scan the whole (doc-comment-stripped, so a model's name appearing in
// prose can't false-positive) group for each known model name as a whole word. Same word-
// boundary-against-known-names approach as e.g. types.js's own List</Set<...> extraction
// elsewhere in this codebase - just applied at the group level instead of one field at a time.
function referencedModelNames(group) {
  const text = JSON.stringify(group.operations, (key, value) =>
    key === "description" || key === "docComment" || key === "summary" ? undefined : value
  );
  const found = [];
  for (const name of registry.models.keys()) {
    if (new RegExp(`\\b${name}\\b`).test(text)) found.push(name);
  }
  return found.sort();
}

if (generate !== "models") {
  for (const [, group] of groups) {
    const referencedModels = referencedModelNames(group);
    // .validate() (api_routes.kt.j2's op.body.hasValidate) is a top-level extension function in
    // ModelValidation.kt (root package) - importing it by name (not per-model) is enough, Kotlin
    // resolves the right overload by the call's receiver type.
    const needsValidate = group.operations.some((op) => op.body && op.body.hasValidate);
    const data = {
      packageName,
      modelsPackage,
      apisPackage,
      tagClass: group.tagClass,
      tagDescription: group.description,
      operations: group.operations,
      referencedModels,
      needsValidate,
    };
    renderTemplate("templates/api_handler.kt.j2", data, `apis/${group.tagClass}Handler.kt`);
    renderTemplate("templates/api_routes.kt.j2", data, `apis/${group.tagClass}Routes.kt`);
  }

  renderTemplate("templates/validation.kt.j2", { packageName, modelsPackage, apisPackage }, "Validation.kt");

  // Routes call .validate() (see api_routes.kt.j2's op.body.hasValidate) on whatever the body
  // model type turns out to be, whether or not this run also generated models/*.kt - so these
  // extensions always render alongside the routes/handlers, never alongside models/*.kt itself.
  const validatedModels = registry.order.map((name) => registry.models.get(name)).filter((model) => model.kind === "object");
  renderTemplate(
    "templates/model_validation.kt.j2",
    { packageName, modelsPackage, apisPackage, models: validatedModels },
    "ModelValidation.kt"
  );
}

dump(`Generated (mode: ${generate}) ${registry.order.length} model(s) and ${groups.size} operation group(s)`);

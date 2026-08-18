import { buildModelRegistry, configureDateTimeType } from "./lib/types.js";
import { collectOperationsByTag } from "./lib/operations.js";

const packageName = vars.packageName;
const modelsPackage = `${packageName}.models`;
const apisPackage = `${packageName}.apis`;
configureDateTimeType(vars.dateTimeType);

const GENERATE_MODES = ["all", "models", "api"];
const generate = vars.generate || "all";
if (!GENERATE_MODES.includes(generate)) {
  throw Error(`<4a3a8b64> Unsupported generate "${generate}"; expected one of ${GENERATE_MODES.join(", ")}`);
}

const registry = buildModelRegistry(schema);
// May register additional inline models discovered only in operation params/bodies/responses -
// must run before rendering models below so nothing is missed.
const groups = collectOperationsByTag(registry);

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
    if (!tmpl) throw Error(`<15755a9e> Unknown model kind: ${model.kind}`);
    renderTemplate(tmpl, { packageName, modelsPackage, apisPackage, model }, `models/${name}.kt`);
  }
}

// A group's operations reference generated model types only as embedded identifiers inside
// already-formatted Kotlin type strings (signatureParams, response.type, ...) - rather than
// threading a parallel "which models does this operation touch" list through every shape in
// operations.js, scan the whole (doc-comment-stripped, so a model's name appearing in prose can't
// false-positive) group for each known model name as a whole word. Same word-boundary-against-
// known-names approach as e.g. types.js's own List</Set<...> extraction elsewhere in this
// codebase - just applied at the group level instead of one field at a time.
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
    renderTemplate(
      "templates/api_client.kt.j2",
      {
        packageName,
        modelsPackage,
        apisPackage,
        tagClass: group.tagClass,
        tagDescription: group.description,
        operations: group.operations,
        referencedModels: referencedModelNames(group),
      },
      `apis/${group.tagClass}.kt`
    );
  }

  renderTemplate("templates/query_utils.kt.j2", { packageName, modelsPackage, apisPackage }, "QueryUtils.kt");

  // The document's own top-level description (info.description) - distinct from a tag's
  // description (group.description, already threaded onto each per-tag class) - is the only
  // sensible source of doc text for the bundle class, since it represents the whole API, not any
  // one tag.
  const apiDescription = (schema.info && schema.info.description) || null;

  renderTemplate(
    "templates/api_bundle.kt.j2",
    {
      packageName,
      modelsPackage,
      apisPackage,
      apiDescription,
      groups: [...groups.values()].map((g) => ({ tagClass: g.tagClass, propertyName: g.propertyName, description: g.description })),
    },
    "ApiClient.kt"
  );
}

dump(`Generated (mode: ${generate}) ${registry.order.length} model(s) and ${groups.size} operation group(s)`);

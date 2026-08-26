import { buildModelRegistry, finalizeModels } from "./lib/types.js";
import { collectOperationsByTag } from "./lib/operations.js";

const packageName = vars.packageName;

const GENERATE_MODES = ["all", "models", "api"];
const generate = vars.generate || "all";
if (!GENERATE_MODES.includes(generate)) {
  throw Error(`<7a3f9c11> Unsupported generate "${generate}"; expected one of ${GENERATE_MODES.join(", ")}`);
}

const registry = buildModelRegistry(schema);
// May register additional inline models discovered only in operation params/bodies/responses -
// must run before finalizeModels/rendering models below so nothing is missed.
const groups = collectOperationsByTag(registry);
finalizeModels(registry);

const MODEL_TEMPLATES = {
  object: "templates/model_struct.go.j2",
  enum: "templates/model_enum.go.j2",
  union: "templates/model_union.go.j2",
  alias: "templates/model_alias.go.j2",
};

if (generate !== "api") {
  for (const name of registry.order) {
    const model = registry.models.get(name);
    const tmpl = MODEL_TEMPLATES[model.kind];
    if (!tmpl) throw Error(`<0c2a7e4d> Unknown model kind: ${model.kind}`);
    renderTemplate(tmpl, { model }, `models/${name}.go`);
  }
  copyFile("validation.go", "models/validation.go");
  copyFile("union_helpers.go", "models/union_helpers.go");
}

if (generate !== "models") {
  for (const [, group] of groups) {
    renderTemplate(
      "templates/client_tag.go.j2",
      { packageName, tagType: group.tagType, description: group.description, operations: group.operations, imports: group.imports },
      `client/${group.tagType}.go`
    );
  }

  const apiDescription = (schema.info && schema.info.description) || null;

  renderTemplate(
    "templates/client_bundle.go.j2",
    {
      description: apiDescription,
      groups: [...groups.values()].map((g) => ({ tagType: g.tagType, fieldName: g.tagType.replace(/Client$/, "") })),
    },
    "client/ApiClient.go"
  );
  copyFile("runtime.go", "client/runtime.go");
}

dump(`Generated (mode: ${generate}) ${registry.order.length} model(s) and ${groups.size} operation group(s)`);

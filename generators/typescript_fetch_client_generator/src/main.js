import { buildModelRegistry } from "./lib/types.js";
import { collectOperationsByTag } from "./lib/operations.js";
import { collectReferencedModelNames } from "./lib/imports.js";
import { buildGuardFunction } from "./lib/validation.js";

const importExt = vars.importExtension || "";
const validateResponses = vars.validateResponses === "true";

const registry = buildModelRegistry(schema);
// May register additional inline models discovered only in operation params/bodies/responses -
// must run before rendering models below so nothing is missed.
const groups = collectOperationsByTag(registry, validateResponses);

const MODEL_TEMPLATES = {
  interface: "templates/model_interface.ts.j2",
  enum: "templates/model_enum.ts.j2",
  alias: "templates/model_type_alias.ts.j2",
};

for (const name of registry.order) {
  const model = registry.models.get(name);
  const tmpl = MODEL_TEMPLATES[model.kind];
  if (!tmpl) throw Error(`<c9d0e1f2> Unknown model kind: ${model.kind}`);

  const referencedTypeStrings =
    model.kind === "interface"
      ? model.properties.map((p) => p.tsType)
      : model.kind === "alias"
        ? [model.targetType]
        : [];
  const modelImports = collectReferencedModelNames(referencedTypeStrings, registry, name);
  // The guard function itself may call other models' guards (e.g. a union alias's guard calls
  // each member's is<Member>) - the same name set that needed a type import also needs the
  // guard-function import once validateResponses is on (see the model templates' import block).
  const guardSource = validateResponses ? buildGuardFunction(model) : null;

  renderTemplate(tmpl, { model, modelImports, importExt, validateResponses, guardSource }, `models/${name}.ts`);
}

const tagGroups = [];
for (const [, group] of groups) {
  renderTemplate(
    "templates/api_client.ts.j2",
    {
      tagClass: group.tagClass,
      tagDescription: group.description,
      operations: group.operations,
      modelImports: group.modelImports,
      importExt,
      validateResponses,
    },
    `apis/${group.tagClass}.ts`
  );
  tagGroups.push({ tagClass: group.tagClass, propertyName: group.propertyName, description: group.description });
}

// The document's own top-level description (info.description) - distinct from a tag's
// description (group.description, already threaded onto each per-tag class) - is the only
// sensible source of doc text for the bundle class, since it represents the whole API, not any
// one tag.
const apiDescription = (schema.info && schema.info.description) || null;

copyFile("runtime.ts", "runtime.ts");
renderTemplate("templates/index.ts.j2", { models: registry.order, tagGroups, apiDescription, importExt }, "index.ts");

dump(`Generated ${registry.order.length} model(s) and ${groups.size} operation group(s)`);

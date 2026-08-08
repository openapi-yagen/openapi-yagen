import { buildModelRegistry } from "./lib/types.js";
import { collectOperationsByTag } from "./lib/operations.js";
import { collectReferencedModelNames } from "./lib/imports.js";

const importExt = vars.importExtension || "";

const registry = buildModelRegistry(schema);
// May register additional inline models discovered only in operation params/bodies/responses -
// must run before rendering models below so nothing is missed.
const groups = collectOperationsByTag(registry);

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

  renderTemplate(tmpl, { model, modelImports, importExt }, `models/${name}.ts`);
}

const tagGroups = [];
for (const [, group] of groups) {
  renderTemplate(
    "templates/api_client.ts.j2",
    { tagClass: group.tagClass, operations: group.operations, modelImports: group.modelImports, importExt },
    `apis/${group.tagClass}.ts`
  );
  tagGroups.push({ tagClass: group.tagClass, propertyName: group.propertyName });
}

copyFile("runtime.ts", "runtime.ts");
renderTemplate("templates/index.ts.j2", { models: registry.order, tagGroups, importExt }, "index.ts");

dump(`Generated ${registry.order.length} model(s) and ${groups.size} API client class(es)`);

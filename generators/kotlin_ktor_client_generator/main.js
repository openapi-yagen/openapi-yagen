import { buildModelRegistry } from "./lib/types.js";
import { collectOperationsByTag } from "./lib/operations.js";
import { packageNameToPath } from "./lib/naming.js";

const packageName = vars.packageName;
const pkgPath = packageNameToPath(packageName);

const registry = buildModelRegistry(schema);
// May register additional inline models discovered only in operation params/bodies/responses -
// must run before rendering models below so nothing is missed.
const groups = collectOperationsByTag(registry);

const MODEL_TEMPLATES = {
  object: "templates/model_data_class.kt.j2",
  enum: "templates/model_enum.kt.j2",
  sealed: "templates/model_sealed.kt.j2",
  typealias: "templates/model_typealias.kt.j2",
};

for (const name of registry.order) {
  const model = registry.models.get(name);
  const tmpl = MODEL_TEMPLATES[model.kind];
  if (!tmpl) throw Error(`<a1b2c3d4> Unknown model kind: ${model.kind}`);
  renderTemplate(tmpl, { packageName, model }, `${pkgPath}/models/${name}.kt`);
}

for (const [, group] of groups) {
  renderTemplate(
    "templates/api_client.kt.j2",
    { packageName, tagClass: group.tagClass, operations: group.operations },
    `${pkgPath}/apis/${group.tagClass}.kt`
  );
}

renderTemplate("templates/query_utils.kt.j2", { packageName }, `${pkgPath}/QueryUtils.kt`);

dump(`Generated ${registry.order.length} model(s) and ${groups.size} API client class(es)`);

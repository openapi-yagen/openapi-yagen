import { buildModelRegistry, finalizeModels } from "./lib/types.js";
import { collectOperationsByTag } from "./lib/operations.js";

const packageName = vars.packageName;

const GENERATE_MODES = ["all", "models", "api"];
const generate = vars.generate || "all";
if (!GENERATE_MODES.includes(generate)) {
  throw Error(`<3d6a8b21> Unsupported generate "${generate}"; expected one of ${GENERATE_MODES.join(", ")}`);
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
    if (!tmpl) throw Error(`<5e9f2a04> Unknown model kind: ${model.kind}`);
    renderTemplate(tmpl, { model }, `models/${name}.go`);
  }
  copyFile("validation.go", "models/validation.go");
  copyFile("union_helpers.go", "models/union_helpers.go");
}

if (generate !== "models") {
  for (const [, group] of groups) {
    renderTemplate(
      "templates/server_handler.go.j2",
      { packageName, handlerType: group.handlerType, description: group.description, operations: group.operations, handlerImports: group.handlerImports },
      `server/${group.handlerType}.go`
    );
    renderTemplate(
      "templates/server_routes.go.j2",
      {
        packageName,
        handlerType: group.handlerType,
        registerFunc: group.registerFunc,
        description: group.description,
        operations: group.operations,
        routesImports: group.routesImports,
      },
      `server/${group.registerFunc}.go`
    );
  }
  renderTemplate("runtime.go.j2", { packageName }, "server/runtime.go");
}

dump(`Generated (mode: ${generate}) ${registry.order.length} model(s) and ${groups.size} operation group(s)`);

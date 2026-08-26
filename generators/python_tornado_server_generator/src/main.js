import { buildModelRegistry } from "./lib/types.js";
import { collectOperationsByPathAndTag } from "./lib/operations.js";

const packageName = vars.packageName;
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(packageName)) {
  throw Error(`<d1e6a9b3> packageName must be a valid Python identifier, got "${packageName}"`);
}

const GENERATE_MODES = ["all", "models", "api"];
const generate = vars.generate || "all";
if (!GENERATE_MODES.includes(generate)) {
  throw Error(`<7c2f4a91> Unsupported generate "${generate}"; expected one of ${GENERATE_MODES.join(", ")}`);
}

// Every generated RequestHandler subclasses this instead of a bare tornado.web.RequestHandler when
// set - the integration point for an app-provided error-body/logging base class (see README
// "Integrating the generated code"). Empty (default) means tornado.web.RequestHandler itself.
const handlerBaseClassPath = vars.handlerBaseClass || "";
let handlerBase = { module: null, className: "RequestHandler" };
if (handlerBaseClassPath) {
  const lastDot = handlerBaseClassPath.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === handlerBaseClassPath.length - 1) {
    throw Error(`<2f8b6a1d> handlerBaseClass must be a dotted "module.path.ClassName", got "${handlerBaseClassPath}"`);
  }
  handlerBase = { module: handlerBaseClassPath.slice(0, lastDot), className: handlerBaseClassPath.slice(lastDot + 1) };
}

const registry = buildModelRegistry(schema);
// May register additional inline models discovered only in operation params/bodies/responses -
// must run before rendering models.py below so nothing is missed.
const tagGroups = collectOperationsByPathAndTag(registry);

copyFile("runtime.py", `${packageName}/runtime.py`);
copyFile("package_init.py", `${packageName}/__init__.py`);

if (generate !== "api") {
  const models = registry.order.map((name) => registry.models.get(name));
  const needsEnum = models.some((m) => m.kind === "enum");
  renderTemplate("templates/models.py.j2", { models, needsEnum }, `${packageName}/models.py`);
}

if (generate !== "models") {
  copyFile("apis_init.py", `${packageName}/apis/__init__.py`);
  for (const [, group] of tagGroups) {
    renderTemplate("templates/api_module.py.j2", { packageName, handlerBase, ...group }, `${packageName}/apis/${group.tagModule}.py`);
  }
}

dump(`Generated (mode: ${generate}) ${registry.order.length} model(s) and ${tagGroups.size} tag group(s)`);

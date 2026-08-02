import { commonFuncs } from "./lib.js";

dump("Hello world", {"key":["value"]})

renderTemplate(
  "model.h.j2",
  { schemas: schema.components.schemas, namespace: vars.namespace },
  "model.h",
  commonFuncs
);

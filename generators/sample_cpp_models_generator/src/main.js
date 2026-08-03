import { commonFuncs, mapType } from "./lib.js";

dump("Hello world", {"key":["value"]})

// A property/schema object built with a field set to `undefined` (e.g. a missing `description`)
// round-trips as a JSON `null` once inside a template-called function's arguments - and the
// engine's inja bridge doesn't accept `null` there (only in plain render `data`). So build plain
// objects below with only the fields that are actually present, never an `undefined`/`null` one.
function toTemplateProp(propSchema) {
  const prop = { type: propSchema.type };
  if (propSchema.description) prop.description = propSchema.description;
  return prop;
}

// nameOf() relies on JS object identity, which only survives up to this point - renderTemplate's
// `data` gets converted through Node (see README's "renderTemplate" docs), a plain value tree with
// no object identity, so `nameOf` can no longer resolve anything once inside a template. Resolve
// each array schema's item type name here, in JS, and pass it through as a plain string instead.
const schemasForTemplate = {};
for (const [name, s] of Object.entries(schema.components.schemas)) {
  const entry = { type: s.type };
  if (s.description) entry.description = s.description;

  const kind = kindOf(s);
  if (kind === "Object") {
    entry.properties = {};
    for (const [propName, propSchema] of Object.entries(s.properties || {})) {
      entry.properties[propName] = toTemplateProp(propSchema);
    }
    entry.required = s.required || [];
  } else if (kind === "Array") {
    entry.itemsName = nameOf(s.items) || mapType(s.items.type);
  }

  schemasForTemplate[name] = entry;
}

renderTemplate(
  "model.h.j2",
  { schemas: schemasForTemplate, namespace: vars.namespace },
  "model.h",
  commonFuncs
);

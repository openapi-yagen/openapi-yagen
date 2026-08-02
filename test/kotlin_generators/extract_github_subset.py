#!/usr/bin/env python3
"""
Extracts a small, self-contained subset of the real GitHub Enterprise Server OpenAPI spec
(test/resources/ghes-3.15.yaml) that's compatible with the kotlin_ktor_{client,server}_generator
generators' documented v1 limitations (discriminated-only oneOf/anyOf with $ref-only variants;
no inline oneOf/anyOf anywhere else; primitive-only path/query/header parameters), producing
test/resources/ghes-subset.yaml, a real-world fixture used by run_tests.sh.

Not part of the automated test run itself (needs pyyaml, and only needs to be re-run if
ghes-3.15.yaml changes or the generators' supported feature set grows). Run from the repo root:

    python3 -m venv /tmp/venv && . /tmp/venv/bin/activate && pip install pyyaml
    python3 test/kotlin_generators/extract_github_subset.py
"""
import sys

import yaml

SRC = "test/resources/ghes-3.15.yaml"
OUT = "test/resources/ghes-subset.yaml"

PREFERRED_PATH_PREFIXES = [
    "/repos/{owner}/{repo}/issues",
    "/repos/{owner}/{repo}/labels",
    "/repos/{owner}/{repo}",
    "/users/{username}",
    "/orgs/{org}",
]


def is_ref(node):
    return isinstance(node, dict) and "$ref" in node


def ref_target(ref):
    parts = ref.lstrip("#/").split("/")
    return parts[1], parts[2]


def walk_refs(node, found):
    if isinstance(node, dict):
        if "$ref" in node:
            found.add(node["$ref"])
        for v in node.values():
            walk_refs(v, found)
    elif isinstance(node, list):
        for item in node:
            walk_refs(item, found)


def schema_has_bad_oneof(schema, top_level, sections):
    """True if `schema` uses oneOf/anyOf in a way the generators can't handle: inline (not a
    named top-level schema), or top-level without a proper discriminator + $ref-only variants."""
    if not isinstance(schema, dict):
        return False
    if "oneOf" in schema or "anyOf" in schema:
        variants = schema.get("oneOf") or schema.get("anyOf")
        if top_level:
            disc = schema.get("discriminator")
            if not disc or not disc.get("propertyName"):
                return True
            if not all(is_ref(v) for v in variants):
                return True
        else:
            return True
    props = schema.get("properties")
    if isinstance(props, dict):
        for pschema in props.values():
            if schema_has_bad_oneof(pschema, False, sections):
                return True
    if "items" in schema and not is_ref(schema["items"]):
        if schema_has_bad_oneof(schema["items"], False, sections):
            return True
    ap = schema.get("additionalProperties")
    if isinstance(ap, dict) and not is_ref(ap):
        if schema_has_bad_oneof(ap, False, sections):
            return True
    for sub in schema.get("allOf", []) or []:
        if not is_ref(sub):
            if schema_has_bad_oneof(sub, False, sections):
                return True
    return False


def collect_closure(start_refs, sections):
    needed = {"schemas": set(), "parameters": set(), "responses": set(), "headers": set()}
    queue = list(start_refs)
    seen = set()
    while queue:
        ref = queue.pop()
        if ref in seen:
            continue
        seen.add(ref)
        section, name = ref_target(ref)
        if section not in sections:
            continue
        if name in needed.get(section, set()):
            continue
        obj = sections[section].get(name)
        if obj is None:
            continue
        needed[section].add(name)
        found = set()
        walk_refs(obj, found)
        queue.extend(found)
    return needed


def closure_is_compatible(closure, sections):
    for name in closure["schemas"]:
        schema = sections["schemas"][name]
        if schema_has_bad_oneof(schema, True, sections):
            return False
    return True


def resolve_param(p, sections):
    if is_ref(p):
        _, name = ref_target(p["$ref"])
        return sections["parameters"].get(name)
    return p


def param_schema_ok(schema):
    """Mirrors operations.js's PARAM_CONVERTERS: only inline string/integer/number/boolean
    schemas (no enum, no $ref - ktType always returns a class name for $ref, never a primitive,
    and enum/date-time formats map to non-primitive Kotlin types) are usable as a path/query/
    header parameter type in the generators."""
    if schema is None:
        return True
    if is_ref(schema):
        return False
    if "enum" in schema:
        return False
    if schema.get("format") in ("date", "date-time"):
        return False
    return schema.get("type") in ("string", "integer", "number", "boolean")


def op_params_ok(op, path_item, sections):
    for p in (path_item.get("parameters") or []) + (op.get("parameters") or []):
        resolved = resolve_param(p, sections)
        if resolved is None:
            return False
        if not param_schema_ok(resolved.get("schema")):
            return False
    return True


def op_direct_refs_and_inline_schemas(op, path_item):
    """Returns (refs, inline_schemas) referenced directly by this operation (params/body/responses)."""
    refs = set()
    inline_schemas = []

    def add_schema(s):
        if s is None:
            return
        # Always walk for nested $refs (e.g. an inline `{type: array, items: {$ref: ...}}`
        # response wrapper) - only checking the top-level node misses everything inside it.
        walk_refs(s, refs)
        if not is_ref(s):
            inline_schemas.append(s)

    for p in (path_item.get("parameters") or []) + (op.get("parameters") or []):
        if is_ref(p):
            refs.add(p["$ref"])
        else:
            add_schema(p.get("schema"))

    rb = op.get("requestBody")
    if rb is not None:
        if is_ref(rb):
            refs.add(rb["$ref"])
        else:
            content = rb.get("content", {}).get("application/json")
            if content:
                add_schema(content.get("schema"))

    for code, resp in (op.get("responses") or {}).items():
        if not (code == "default" or code.startswith("2")):
            continue
        if is_ref(resp):
            refs.add(resp["$ref"])
            continue
        content = (resp.get("content") or {}).get("application/json")
        if content:
            add_schema(content.get("schema"))

    return refs, inline_schemas


def main():
    with open(SRC) as f:
        spec = yaml.safe_load(f)

    sections = {
        "schemas": spec["components"].get("schemas", {}),
        "parameters": spec["components"].get("parameters", {}),
        "responses": spec["components"].get("responses", {}),
        "headers": spec["components"].get("headers", {}),
    }

    methods = ["get", "put", "post", "delete", "options", "head", "patch"]

    buckets = {p: [] for p in PREFERRED_PATH_PREFIXES}
    for path, path_item in spec["paths"].items():
        if not isinstance(path_item, dict):
            continue
        prefix = next((p for p in PREFERRED_PATH_PREFIXES if path.startswith(p)), None)
        if prefix is None:
            continue
        # Allow the resource itself plus at most one sub-segment (e.g. .../issues/{issue_number})
        # for a readable subset, not arbitrarily deep sub-collections.
        remainder = path[len(prefix):].strip("/")
        if remainder and len(remainder.split("/")) > 1:
            continue
        for method in methods:
            op = path_item.get(method)
            if not op:
                continue
            if not op_params_ok(op, path_item, sections):
                continue
            refs, inline_schemas = op_direct_refs_and_inline_schemas(op, path_item)
            if any(schema_has_bad_oneof(s, False, sections) for s in inline_schemas):
                continue
            closure = collect_closure(refs, sections)
            if not closure_is_compatible(closure, sections):
                continue
            buckets[prefix].append((path, method, op, path_item, closure))

    # Round-robin across resource buckets for a diverse, readable subset (not all from one prefix).
    method_priority = {"get": 0, "post": 1, "patch": 2, "put": 3, "delete": 4}
    for p in buckets:
        buckets[p].sort(key=lambda c: (c[0], method_priority.get(c[1], 9)))

    MAX_OPS = 16
    chosen = []
    while len(chosen) < MAX_OPS and any(buckets.values()):
        for p in PREFERRED_PATH_PREFIXES:
            if buckets[p]:
                chosen.append(buckets[p].pop(0))
            if len(chosen) >= MAX_OPS:
                break
    candidates = [c for bucket in buckets.values() for c in bucket] + chosen

    if not chosen:
        print("No compatible operations found!", file=sys.stderr)
        sys.exit(1)

    print(f"Selected {len(chosen)} operations out of {len(candidates)} compatible candidates:")
    for path, method, op, _, _ in chosen:
        print(f"  {method.upper():6} {path}  (operationId={op.get('operationId')})")

    all_needed = {"schemas": set(), "parameters": set(), "responses": set(), "headers": set()}
    new_paths = {}
    for path, method, op, path_item, closure in chosen:
        for k in all_needed:
            all_needed[k] |= closure[k]
        new_paths.setdefault(path, {})[method] = op

    assert closure_is_compatible(all_needed, sections), "combined closure became incompatible!"

    new_spec = {
        "openapi": spec.get("openapi", "3.0.3"),
        "info": {
            "title": "GitHub Enterprise Server API (test subset)",
            "version": spec.get("info", {}).get("version", "3.15"),
            "description": (
                "A small, hand-curated subset of the real GitHub Enterprise Server 3.15 REST API "
                "spec (see ghes-3.15.yaml), extracted for integration testing the Kotlin/Ktor "
                "generators against real-world spec content. Only operations whose full schema "
                "closure is compatible with the generators' documented v1 limitations "
                "(discriminated-only oneOf/anyOf, no inline oneOf/anyOf) were kept - see "
                "extract_github_subset.py used to produce this file."
            ),
        },
        "paths": new_paths,
        "components": {
            "schemas": {k: sections["schemas"][k] for k in sorted(all_needed["schemas"])},
        },
    }
    if all_needed["parameters"]:
        new_spec["components"]["parameters"] = {k: sections["parameters"][k] for k in sorted(all_needed["parameters"])}
    if all_needed["responses"]:
        new_spec["components"]["responses"] = {k: sections["responses"][k] for k in sorted(all_needed["responses"])}
    if all_needed["headers"]:
        new_spec["components"]["headers"] = {k: sections["headers"][k] for k in sorted(all_needed["headers"])}

    with open(OUT, "w") as f:
        yaml.safe_dump(new_spec, f, sort_keys=False, allow_unicode=True, width=100)

    print(f"\nWrote {OUT}")
    print(f"  schemas: {len(all_needed['schemas'])}, parameters: {len(all_needed['parameters'])}, "
          f"responses: {len(all_needed['responses'])}, headers: {len(all_needed['headers'])}")


if __name__ == "__main__":
    main()

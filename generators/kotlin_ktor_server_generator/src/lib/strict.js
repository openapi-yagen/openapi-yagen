// Strict/permissive generation mode (see generator.yml's "strict" variable): by default (strict),
// an unsupported schema or operation aborts generation with an error. With `-v strict=false`,
// such a construct is instead skipped with a warning and generation continues - useful for large
// real-world specs where a handful of unsupported constructs shouldn't block everything else.

export function isStrict() {
  return vars.strict !== "false";
}

// Runs `fn()` for its side effects (registering a model/operation). In strict mode, any error it
// throws propagates as-is. In permissive mode, the error is caught, reported via dump() as a
// warning, and `onError()` runs instead (typically registering a fallback, or doing nothing to
// skip the item entirely).
export function withResilience(label, fn, onError) {
  if (isStrict()) {
    fn();
    return;
  }
  try {
    fn();
  } catch (e) {
    dump(`WARNING: skipping ${label}: ${e.message || e}`);
    onError();
  }
}

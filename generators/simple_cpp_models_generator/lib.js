/**
 * Maps spec type to C++ type
 **/
export function mapType(type) {
  switch (type) {
    case "integer":
      return "int";
    case "string":
      return "std::string";
    default:
      throw Error(`<234a4b27> Unsupported type: ${type}`);
  }
}

function renderDescriptionComment(obj) {
  return renderTemplateToString("comment.j2", { obj });
}

function isFieldRequired(fieldName, requiredFields) {
  return !!(requiredFields || []).find((v) => v == fieldName);
}

// nameOf/kindOf rely on JS object identity and only work in main.js, before a schema is passed
// into renderTemplate (see main.js) - not usable from within a template itself, so they're not
// included here.
export const commonFuncs = {
  mapType,
  renderDescriptionComment,
  isFieldRequired,
};

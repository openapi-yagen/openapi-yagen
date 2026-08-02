/**
 * Maps spec type to C++ type
 **/
function mapType(type) {
  switch (type) {
    case "integer":
      return "int";
    case "string":
      return "std::string";
    default:
      throw Error(`<234a4b27> Unsupported type: ${type}`);
  }
}

/**
 * Get model name from $ref
 **/
function getModelNameByRef(refObject) {
  const refVal = refObject["$ref"];
  if (!refVal) throw Error(`<93ee6b4e> Ref not found: ${refObject}`);
  const rx = /\/([^/]+)$/;
  const v = rx.exec(refVal);
  if (v.length != 2)
    throw Error(`<9b8b3ff1> Invalid reference format: ${refVal}`);
  return v[1];
}

function renderDescriptionComment(obj) {
  return renderTemplateToString("comment.j2", { obj });
}

function isFieldRequired(fieldName, requiredFields) {
  return !!requiredFields.find((v) => v == fieldName);
}

export const commonFuncs = {
  mapType,
  getModelNameByRef,
  renderDescriptionComment,
  isFieldRequired,
};

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: !0 });
}, __copyProps = (to, from, except, desc) => {
  if (from && typeof from == "object" || typeof from == "function")
    for (let key of __getOwnPropNames(from))
      !__hasOwnProp.call(to, key) && key !== except && __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: !0 }), mod);
var schema_exports = {};
__export(schema_exports, {
  coercePrimitiveRoot: () => coercePrimitiveRoot,
  getCookieValidator: () => getCookieValidator,
  getResponseSchemaValidator: () => getResponseSchemaValidator,
  getSchemaValidator: () => getSchemaValidator,
  hasAdditionalProperties: () => hasAdditionalProperties,
  hasElysiaMeta: () => hasElysiaMeta,
  hasProperty: () => hasProperty,
  hasRef: () => hasRef,
  hasTransform: () => hasTransform,
  hasType: () => hasType,
  isOptional: () => isOptional,
  isUnion: () => isUnion,
  mergeObjectSchemas: () => mergeObjectSchemas,
  queryCoercions: () => queryCoercions,
  replaceSchemaType: () => replaceSchemaType,
  stringToStructureCoercions: () => stringToStructureCoercions,
  unwrapImportSchema: () => unwrapImportSchema
});
module.exports = __toCommonJS(schema_exports);
var import_typebox = require("@sinclair/typebox"), import_value = require("@sinclair/typebox/value"), import_compiler = require("@sinclair/typebox/compiler"), import_exact_mirror = require("exact-mirror"), import_type_system = require('./type-system/index.js'), import_utils = require('./utils.js'), import_error = require('./error.js');
const isOptional = (schema) => schema ? schema?.[import_typebox.Kind] === "Import" && schema.References ? schema.References().some(isOptional) : (schema.schema && (schema = schema.schema), !!schema && import_typebox.OptionalKind in schema) : !1, hasAdditionalProperties = (_schema) => {
  if (!_schema) return !1;
  const schema = _schema?.schema ?? _schema;
  if (schema[import_typebox.Kind] === "Import" && _schema.References)
    return _schema.References().some(hasAdditionalProperties);
  if (schema.anyOf) return schema.anyOf.some(hasAdditionalProperties);
  if (schema.someOf) return schema.someOf.some(hasAdditionalProperties);
  if (schema.allOf) return schema.allOf.some(hasAdditionalProperties);
  if (schema.not) return schema.not.some(hasAdditionalProperties);
  if (schema.type === "object") {
    const properties = schema.properties;
    if ("additionalProperties" in schema) return schema.additionalProperties;
    if ("patternProperties" in schema) return !1;
    for (const key of Object.keys(properties)) {
      const property = properties[key];
      if (property.type === "object") {
        if (hasAdditionalProperties(property)) return !0;
      } else if (property.anyOf) {
        for (let i = 0; i < property.anyOf.length; i++)
          if (hasAdditionalProperties(property.anyOf[i])) return !0;
      }
      return property.additionalProperties;
    }
    return !1;
  }
  return schema.type === "array" && schema.items && !Array.isArray(schema.items) ? hasAdditionalProperties(schema.items) : !1;
}, hasType = (type, schema) => {
  if (!schema) return !1;
  if (import_typebox.Kind in schema && schema[import_typebox.Kind] === type) return !0;
  if (schema.type === "object") {
    const properties = schema.properties;
    if (!properties) return !1;
    for (const key of Object.keys(properties)) {
      const property = properties[key];
      if (property.type === "object") {
        if (hasType(type, property)) return !0;
      } else if (property.anyOf) {
        for (let i = 0; i < property.anyOf.length; i++)
          if (hasType(type, property.anyOf[i])) return !0;
      }
      if (import_typebox.Kind in property && property[import_typebox.Kind] === type) return !0;
    }
    return !1;
  }
  return !!schema.properties && import_typebox.Kind in schema.properties && schema.properties[import_typebox.Kind] === type;
}, hasElysiaMeta = (meta, _schema) => {
  if (!_schema) return !1;
  const schema = _schema?.schema ?? _schema;
  if (schema.elysiaMeta === meta) return !0;
  if (schema[import_typebox.Kind] === "Import" && _schema.References)
    return _schema.References().some((schema2) => hasElysiaMeta(meta, schema2));
  if (schema.anyOf)
    return schema.anyOf.some(
      (schema2) => hasElysiaMeta(meta, schema2)
    );
  if (schema.someOf)
    return schema.someOf.some(
      (schema2) => hasElysiaMeta(meta, schema2)
    );
  if (schema.allOf)
    return schema.allOf.some(
      (schema2) => hasElysiaMeta(meta, schema2)
    );
  if (schema.not)
    return schema.not.some((schema2) => hasElysiaMeta(meta, schema2));
  if (schema.type === "object") {
    const properties = schema.properties;
    for (const key of Object.keys(properties)) {
      const property = properties[key];
      if (property.type === "object") {
        if (hasElysiaMeta(meta, property)) return !0;
      } else if (property.anyOf) {
        for (let i = 0; i < property.anyOf.length; i++)
          if (hasElysiaMeta(meta, property.anyOf[i])) return !0;
      }
      return schema.elysiaMeta === meta;
    }
    return !1;
  }
  return schema.type === "array" && schema.items && !Array.isArray(schema.items) ? hasElysiaMeta(meta, schema.items) : !1;
}, hasProperty = (expectedProperty, _schema) => {
  if (!_schema) return;
  const schema = _schema.schema ?? _schema;
  if (schema[import_typebox.Kind] === "Import" && _schema.References)
    return _schema.References().some((schema2) => hasProperty(expectedProperty, schema2));
  if (schema.type === "object") {
    const properties = schema.properties;
    if (!properties) return !1;
    for (const key of Object.keys(properties)) {
      const property = properties[key];
      if (expectedProperty in property) return !0;
      if (property.type === "object") {
        if (hasProperty(expectedProperty, property)) return !0;
      } else if (property.anyOf) {
        for (let i = 0; i < property.anyOf.length; i++)
          if (hasProperty(expectedProperty, property.anyOf[i]))
            return !0;
      }
    }
    return !1;
  }
  return expectedProperty in schema;
}, hasRef = (schema) => {
  if (!schema) return !1;
  if (schema.oneOf) {
    for (let i = 0; i < schema.oneOf.length; i++)
      if (hasRef(schema.oneOf[i])) return !0;
  }
  if (schema.anyOf) {
    for (let i = 0; i < schema.anyOf.length; i++)
      if (hasRef(schema.anyOf[i])) return !0;
  }
  if (schema.oneOf) {
    for (let i = 0; i < schema.oneOf.length; i++)
      if (hasRef(schema.oneOf[i])) return !0;
  }
  if (schema.allOf) {
    for (let i = 0; i < schema.allOf.length; i++)
      if (hasRef(schema.allOf[i])) return !0;
  }
  if (schema.not && hasRef(schema.not)) return !0;
  if (schema.type === "object" && schema.properties) {
    const properties = schema.properties;
    for (const key of Object.keys(properties)) {
      const property = properties[key];
      if (hasRef(property) || property.type === "array" && property.items && hasRef(property.items))
        return !0;
    }
  }
  return schema.type === "array" && schema.items && hasRef(schema.items) ? !0 : schema[import_typebox.Kind] === "Ref" && "$ref" in schema;
}, hasTransform = (schema) => {
  if (!schema) return !1;
  if (schema.$ref && schema.$defs && schema.$ref in schema.$defs && hasTransform(schema.$defs[schema.$ref]))
    return !0;
  if (schema.oneOf) {
    for (let i = 0; i < schema.oneOf.length; i++)
      if (hasTransform(schema.oneOf[i])) return !0;
  }
  if (schema.anyOf) {
    for (let i = 0; i < schema.anyOf.length; i++)
      if (hasTransform(schema.anyOf[i])) return !0;
  }
  if (schema.allOf) {
    for (let i = 0; i < schema.allOf.length; i++)
      if (hasTransform(schema.allOf[i])) return !0;
  }
  if (schema.not && hasTransform(schema.not)) return !0;
  if (schema.type === "object" && schema.properties) {
    const properties = schema.properties;
    for (const key of Object.keys(properties)) {
      const property = properties[key];
      if (hasTransform(property) || property.type === "array" && property.items && hasTransform(property.items))
        return !0;
    }
  }
  return schema.type === "array" && schema.items && hasTransform(schema.items) ? !0 : import_typebox.TransformKind in schema;
}, replaceSchemaType = (schema, options, _config = {}) => {
  const config = _config;
  if (config.root = !0, !Array.isArray(options))
    return options.original = schema, _replaceSchemaType(schema, options, config);
  for (const option of options)
    option.original = schema, schema = _replaceSchemaType(schema, option, config);
  return schema;
}, _replaceSchemaType = (schema, options, config) => {
  if (!schema) return schema;
  const root = config.root;
  if (options.onlyFirst && schema.type === options.onlyFirst)
    return options.to(schema) ?? schema;
  if (options.untilObjectFound && !root && schema.type === "object")
    return schema;
  const fromSymbol = options.from[import_typebox.Kind];
  if (schema.oneOf) {
    for (let i = 0; i < schema.oneOf.length; i++)
      schema.oneOf[i] = _replaceSchemaType(
        schema.oneOf[i],
        options,
        config
      );
    return schema;
  }
  if (schema.anyOf) {
    for (let i = 0; i < schema.anyOf.length; i++)
      schema.anyOf[i] = _replaceSchemaType(
        schema.anyOf[i],
        options,
        config
      );
    return schema;
  }
  if (schema.allOf) {
    for (let i = 0; i < schema.allOf.length; i++)
      schema.allOf[i] = _replaceSchemaType(
        schema.allOf[i],
        options,
        config
      );
    return schema;
  }
  if (schema.not) return _replaceSchemaType(schema.not, options, config);
  const isRoot = root && !!options.excludeRoot;
  if (schema[import_typebox.Kind] === fromSymbol) {
    const { anyOf, oneOf, allOf, not, properties: properties2, items, ...rest } = schema, to = options.to(rest);
    if (!to) return schema;
    let transform;
    const composeProperties = (schema2) => {
      const v = _composeProperties(schema2);
      return v.$id && delete v.$id, v;
    }, _composeProperties = (v) => {
      if (properties2 && v.type === "object") {
        const newProperties = {};
        for (const [key, value2] of Object.entries(properties2))
          newProperties[key] = _replaceSchemaType(
            value2,
            options,
            {
              ...config,
              root: !1
            }
          );
        return {
          ...rest,
          ...v,
          properties: newProperties
        };
      }
      if (items && v.type === "array")
        return {
          ...rest,
          ...v,
          items: _replaceSchemaType(items, options, {
            ...config,
            root: !1
          })
        };
      const value = {
        ...rest,
        ...v
      };
      return delete value.required, properties2 && v.type === "string" && v.format === "ObjectString" && v.default === "{}" ? (transform = import_type_system.t.ObjectString(properties2, rest), value.properties = properties2) : items && v.type === "string" && v.format === "ArrayString" && v.default === "[]" && (transform = import_type_system.t.ArrayString(items, rest), value.items = items), value;
    };
    if (isRoot) {
      if (properties2) {
        const newProperties = {};
        for (const [key, value] of Object.entries(properties2))
          newProperties[key] = _replaceSchemaType(
            value,
            options,
            {
              ...config,
              root: !1
            }
          );
        return {
          ...rest,
          properties: newProperties
        };
      } else if (items?.map)
        return {
          ...rest,
          items: items.map(
            (v) => _replaceSchemaType(v, options, {
              ...config,
              root: !1
            })
          )
        };
      return rest;
    }
    if (to.anyOf)
      for (let i = 0; i < to.anyOf.length; i++)
        to.anyOf[i] = composeProperties(to.anyOf[i]);
    else if (to.oneOf)
      for (let i = 0; i < to.oneOf.length; i++)
        to.oneOf[i] = composeProperties(to.oneOf[i]);
    else if (to.allOf)
      for (let i = 0; i < to.allOf.length; i++)
        to.allOf[i] = composeProperties(to.allOf[i]);
    else to.not && (to.not = composeProperties(to.not));
    if (transform && (to[import_typebox.TransformKind] = transform[import_typebox.TransformKind]), to.anyOf || to.oneOf || to.allOf || to.not) return to;
    if (properties2) {
      const newProperties = {};
      for (const [key, value] of Object.entries(properties2))
        newProperties[key] = _replaceSchemaType(
          value,
          options,
          {
            ...config,
            root: !1
          }
        );
      return {
        ...rest,
        ...to,
        properties: newProperties
      };
    } else if (items?.map)
      return {
        ...rest,
        ...to,
        items: items.map(
          (v) => _replaceSchemaType(v, options, {
            ...config,
            root: !1
          })
        )
      };
    return {
      ...rest,
      ...to
    };
  }
  const properties = schema?.properties;
  if (properties && root && options.rootOnly !== !0)
    for (const [key, value] of Object.entries(properties))
      switch (value[import_typebox.Kind]) {
        case fromSymbol:
          const { anyOf, oneOf, allOf, not, type, ...rest } = value, to = options.to(rest);
          if (!to) return schema;
          if (to.anyOf)
            for (let i = 0; i < to.anyOf.length; i++)
              to.anyOf[i] = { ...rest, ...to.anyOf[i] };
          else if (to.oneOf)
            for (let i = 0; i < to.oneOf.length; i++)
              to.oneOf[i] = { ...rest, ...to.oneOf[i] };
          else if (to.allOf)
            for (let i = 0; i < to.allOf.length; i++)
              to.allOf[i] = { ...rest, ...to.allOf[i] };
          else to.not && (to.not = { ...rest, ...to.not });
          properties[key] = {
            ...rest,
            ..._replaceSchemaType(rest, options, {
              ...config,
              root: !1
            })
          };
          break;
        case "Object":
        case "Union":
          properties[key] = _replaceSchemaType(value, options, {
            ...config,
            root: !1
          });
          break;
        default:
          if (Array.isArray(value.items))
            for (let i = 0; i < value.items.length; i++)
              value.items[i] = _replaceSchemaType(
                value.items[i],
                options,
                {
                  ...config,
                  root: !1
                }
              );
          else value.anyOf || value.oneOf || value.allOf || value.not ? properties[key] = _replaceSchemaType(value, options, {
            ...config,
            root: !1
          }) : value.type === "array" && (value.items = _replaceSchemaType(value.items, options, {
            ...config,
            root: !1
          }));
          break;
      }
  return schema.type === "array" && schema.items && (Array.isArray(schema.items) ? schema.items = schema.items.map(
    (item) => _replaceSchemaType(item, options, {
      ...config,
      root: !1
    })
  ) : schema.items = _replaceSchemaType(schema.items, options, {
    ...config,
    root: !1
  })), schema;
}, createCleaner = (schema) => (value) => {
  if (typeof value == "object")
    try {
      return import_value.Value.Clean(schema, value);
    } catch {
    }
  return value;
}, getSchemaValidator = (s, {
  models = {},
  dynamic = !1,
  modules,
  normalize = !1,
  additionalProperties = !1,
  forceAdditionalProperties = !1,
  coerce = !1,
  additionalCoerce = [],
  validators,
  sanitize
} = {}) => {
  if (validators = validators?.filter((x) => x), !s) {
    if (!validators?.length) return;
    s = validators[0], validators = validators.slice(1);
  }
  let doesHaveRef;
  const replaceSchema = (schema2) => coerce ? replaceSchemaType(schema2, [
    {
      from: import_type_system.t.Number(),
      to: (options) => import_type_system.t.Numeric(options),
      untilObjectFound: !0
    },
    {
      from: import_type_system.t.Boolean(),
      to: (options) => import_type_system.t.BooleanString(options),
      untilObjectFound: !0
    },
    ...Array.isArray(additionalCoerce) ? additionalCoerce : [additionalCoerce]
  ]) : replaceSchemaType(schema2, additionalCoerce), mapSchema = (s2) => {
    if (s2 && typeof s2 != "string" && "~standard" in s2)
      return s2;
    if (!s2) return;
    let schema2;
    if (typeof s2 != "string") schema2 = s2;
    else if (schema2 = // @ts-expect-error private property
    modules && s2 in modules.$defs ? modules.Import(s2) : models[s2], !schema2) return;
    if (import_typebox.Kind in schema2)
      if (schema2[import_typebox.Kind] === "Import")
        hasRef(schema2.$defs[schema2.$ref]) || (schema2 = schema2.$defs[schema2.$ref], (coerce || additionalCoerce) && (schema2 = replaceSchema(schema2)));
      else if (hasRef(schema2)) {
        const id = (0, import_utils.randomId)();
        schema2 = import_type_system.t.Module({
          // @ts-expect-error private property
          ...modules?.$defs,
          [id]: schema2
        }).Import(id);
      } else (coerce || additionalCoerce) && (schema2 = replaceSchema(schema2));
    return schema2;
  };
  let schema = mapSchema(s), _validators = validators;
  if ("~standard" in schema || validators?.length && validators.some(
    (x) => x && typeof x != "string" && "~standard" in x
  )) {
    const typeboxSubValidator = (schema2) => {
      let mirror;
      if (normalize === !0 || normalize === "exactMirror")
        try {
          mirror = (0, import_exact_mirror.createMirror)(schema2, {
            TypeCompiler: import_compiler.TypeCompiler,
            sanitize: sanitize?.(),
            modules
          });
        } catch {
          console.warn(
            "Failed to create exactMirror. Please report the following code to https://github.com/elysiajs/elysia/issues"
          ), console.warn(schema2), mirror = createCleaner(schema2);
        }
      const vali = getSchemaValidator(schema2, {
        models,
        modules,
        dynamic,
        normalize,
        additionalProperties: !0,
        forceAdditionalProperties: !0,
        coerce,
        additionalCoerce
      });
      return vali.Decode = mirror, (v) => vali.Check(v) ? {
        value: vali.Decode(v)
      } : {
        issues: [...vali.Errors(v)]
      };
    }, mainCheck = schema["~standard"] ? schema["~standard"].validate : typeboxSubValidator(schema);
    let checkers = [];
    if (validators?.length) {
      for (const validator2 of validators)
        if (validator2 && typeof validator2 != "string") {
          if (validator2?.["~standard"]) {
            checkers.push(validator2["~standard"]);
            continue;
          }
          if (import_typebox.Kind in validator2) {
            checkers.push(typeboxSubValidator(validator2));
            continue;
          }
        }
    }
    async function Check(value) {
      let v = mainCheck(value);
      if (v instanceof Promise && (v = await v), v.issues) return v;
      const values = [];
      v && typeof v == "object" && values.push(v.value);
      for (let i = 0; i < checkers.length; i++) {
        if (v = checkers[i].validate(value), v instanceof Promise && (v = await v), v.issues) return v;
        v && typeof v == "object" && values.push(v.value);
      }
      if (!values.length) return { value: v };
      if (values.length === 1) return { value: values[0] };
      if (values.length === 2)
        return { value: (0, import_utils.mergeDeep)(values[0], values[1]) };
      let newValue = (0, import_utils.mergeDeep)(values[0], values[1]);
      for (let i = 2; i < values.length; i++)
        newValue = (0, import_utils.mergeDeep)(newValue, values[i]);
      return { value: newValue };
    }
    const validator = {
      provider: "standard",
      schema,
      references: "",
      checkFunc: () => {
      },
      code: "",
      // @ts-ignore
      Check,
      // @ts-ignore
      Errors: (value) => Check(value)?.then?.((x) => x?.issues),
      Code: () => "",
      // @ts-ignore
      Decode: Check,
      // @ts-ignore
      Encode: (value) => value,
      hasAdditionalProperties: !1,
      hasDefault: !1,
      isOptional: !1,
      hasTransform: !1,
      hasRef: !1
    };
    return validator.parse = (v) => {
      try {
        return validator.Decode(validator.Clean?.(v) ?? v);
      } catch {
        throw [...validator.Errors(v)].map(import_error.mapValueError);
      }
    }, validator.safeParse = (v) => {
      try {
        return {
          success: !0,
          data: validator.Decode(validator.Clean?.(v) ?? v),
          error: null
        };
      } catch {
        const errors = [...compiled.Errors(v)].map(import_error.mapValueError);
        return {
          success: !1,
          data: null,
          error: errors[0]?.summary,
          errors
        };
      }
    }, validator;
  } else if (validators?.length) {
    let hasAdditional = !1;
    const validators2 = _validators, { schema: mergedObjectSchema, notObjects } = mergeObjectSchemas([
      schema,
      ...validators2.map(mapSchema)
    ]);
    notObjects && (schema = import_type_system.t.Intersect([
      ...mergedObjectSchema ? [mergedObjectSchema] : [],
      ...notObjects.map((x) => {
        const schema2 = mapSchema(x);
        return schema2.type === "object" && "additionalProperties" in schema2 && (!hasAdditional && schema2.additionalProperties === !1 && (hasAdditional = !0), delete schema2.additionalProperties), schema2;
      })
    ]), schema.type === "object" && hasAdditional && (schema.additionalProperties = !1));
  } else
    schema.type === "object" && (!("additionalProperties" in schema) || forceAdditionalProperties) ? schema.additionalProperties = additionalProperties : schema = replaceSchemaType(schema, {
      onlyFirst: "object",
      from: import_type_system.t.Object({}),
      // @ts-ignore
      to({ properties, ...options }) {
        if (properties && !("additionalProperties" in schema))
          return import_type_system.t.Object(properties, {
            ...options,
            additionalProperties: !1
          });
      }
    });
  if (dynamic)
    if (import_typebox.Kind in schema) {
      const validator = {
        provider: "typebox",
        schema,
        references: "",
        checkFunc: () => {
        },
        code: "",
        // @ts-expect-error
        Check: (value) => import_value.Value.Check(schema, value),
        Errors: (value) => import_value.Value.Errors(schema, value),
        Code: () => "",
        Clean: createCleaner(schema),
        Decode: (value) => import_value.Value.Decode(schema, value),
        Encode: (value) => import_value.Value.Encode(schema, value),
        get hasAdditionalProperties() {
          return "~hasAdditionalProperties" in this ? this["~hasAdditionalProperties"] : this["~hasAdditionalProperties"] = hasAdditionalProperties(schema);
        },
        get hasDefault() {
          return "~hasDefault" in this ? this["~hasDefault"] : this["~hasDefault"] = hasProperty(
            "default",
            schema
          );
        },
        get isOptional() {
          return "~isOptional" in this ? this["~isOptional"] : this["~isOptional"] = isOptional(schema);
        },
        get hasTransform() {
          return "~hasTransform" in this ? this["~hasTransform"] : this["~hasTransform"] = hasTransform(schema);
        },
        "~hasRef": doesHaveRef,
        get hasRef() {
          return "~hasRef" in this ? this["~hasRef"] : this["~hasRef"] = hasTransform(schema);
        }
      };
      if (schema.config && (validator.config = schema.config, validator?.schema?.config && delete validator.schema.config), normalize && schema.additionalProperties === !1)
        if (normalize === !0 || normalize === "exactMirror")
          try {
            validator.Clean = (0, import_exact_mirror.createMirror)(schema, {
              TypeCompiler: import_compiler.TypeCompiler,
              sanitize: sanitize?.(),
              modules
            });
          } catch {
            console.warn(
              "Failed to create exactMirror. Please report the following code to https://github.com/elysiajs/elysia/issues"
            ), console.warn(schema), validator.Clean = createCleaner(schema);
          }
        else validator.Clean = createCleaner(schema);
      return validator.parse = (v) => {
        try {
          return validator.Decode(validator.Clean?.(v) ?? v);
        } catch {
          throw [...validator.Errors(v)].map(import_error.mapValueError);
        }
      }, validator.safeParse = (v) => {
        try {
          return {
            success: !0,
            data: validator.Decode(validator.Clean?.(v) ?? v),
            error: null
          };
        } catch {
          const errors = [...compiled.Errors(v)].map(import_error.mapValueError);
          return {
            success: !1,
            data: null,
            error: errors[0]?.summary,
            errors
          };
        }
      }, validator;
    } else {
      const validator = {
        provider: "standard",
        schema,
        references: "",
        checkFunc: () => {
        },
        code: "",
        // @ts-ignore
        Check: (v) => schema["~standard"].validate(v),
        // @ts-ignore
        Errors(value) {
          const response = schema["~standard"].validate(value);
          if (response instanceof Promise)
            throw Error(
              "Async validation is not supported in non-dynamic schema"
            );
          return response.issues;
        },
        Code: () => "",
        // @ts-ignore
        Decode(value) {
          const response = schema["~standard"].validate(value);
          if (response instanceof Promise)
            throw Error(
              "Async validation is not supported in non-dynamic schema"
            );
          return response;
        },
        // @ts-ignore
        Encode: (value) => value,
        hasAdditionalProperties: !1,
        hasDefault: !1,
        isOptional: !1,
        hasTransform: !1,
        hasRef: !1
      };
      return validator.parse = (v) => {
        try {
          return validator.Decode(validator.Clean?.(v) ?? v);
        } catch {
          throw [...validator.Errors(v)].map(import_error.mapValueError);
        }
      }, validator.safeParse = (v) => {
        try {
          return {
            success: !0,
            data: validator.Decode(validator.Clean?.(v) ?? v),
            error: null
          };
        } catch {
          const errors = [...compiled.Errors(v)].map(import_error.mapValueError);
          return {
            success: !1,
            data: null,
            error: errors[0]?.summary,
            errors
          };
        }
      }, validator;
    }
  let compiled;
  if (import_typebox.Kind in schema)
    if (compiled = import_compiler.TypeCompiler.Compile(
      schema,
      Object.values(models).filter((x) => import_typebox.Kind in x)
    ), compiled.provider = "typebox", schema.config && (compiled.config = schema.config, compiled?.schema?.config && delete compiled.schema.config), normalize === !0 || normalize === "exactMirror")
      try {
        compiled.Clean = (0, import_exact_mirror.createMirror)(schema, {
          TypeCompiler: import_compiler.TypeCompiler,
          sanitize: sanitize?.(),
          modules
        });
      } catch {
        console.warn(
          "Failed to create exactMirror. Please report the following code to https://github.com/elysiajs/elysia/issues"
        ), console.dir(schema, {
          depth: null
        }), compiled.Clean = createCleaner(schema);
      }
    else normalize === "typebox" && (compiled.Clean = createCleaner(schema));
  else
    compiled = {
      provider: "standard",
      schema,
      references: "",
      checkFunc(value) {
        const response = schema["~standard"].validate(value);
        if (response instanceof Promise)
          throw Error(
            "Async validation is not supported in non-dynamic schema"
          );
        return response;
      },
      code: "",
      // @ts-ignore
      Check: (v) => schema["~standard"].validate(v),
      // @ts-ignore
      Errors(value) {
        const response = schema["~standard"].validate(value);
        if (response instanceof Promise)
          throw Error(
            "Async validation is not supported in non-dynamic schema"
          );
        return response.issues;
      },
      Code: () => "",
      // @ts-ignore
      Decode(value) {
        const response = schema["~standard"].validate(value);
        if (response instanceof Promise)
          throw Error(
            "Async validation is not supported in non-dynamic schema"
          );
        return response;
      },
      // @ts-ignore
      Encode: (value) => value,
      hasAdditionalProperties: !1,
      hasDefault: !1,
      isOptional: !1,
      hasTransform: !1,
      hasRef: !1
    };
  return compiled.parse = (v) => {
    try {
      return compiled.Decode(compiled.Clean?.(v) ?? v);
    } catch {
      throw [...compiled.Errors(v)].map(import_error.mapValueError);
    }
  }, compiled.safeParse = (v) => {
    try {
      return {
        success: !0,
        data: compiled.Decode(compiled.Clean?.(v) ?? v),
        error: null
      };
    } catch {
      const errors = [...compiled.Errors(v)].map(import_error.mapValueError);
      return {
        success: !1,
        data: null,
        error: errors[0]?.summary,
        errors
      };
    }
  }, import_typebox.Kind in schema && Object.assign(compiled, {
    get hasAdditionalProperties() {
      return "~hasAdditionalProperties" in this ? this["~hasAdditionalProperties"] : this["~hasAdditionalProperties"] = hasAdditionalProperties(compiled);
    },
    get hasDefault() {
      return "~hasDefault" in this ? this["~hasDefault"] : this["~hasDefault"] = hasProperty("default", compiled);
    },
    get isOptional() {
      return "~isOptional" in this ? this["~isOptional"] : this["~isOptional"] = isOptional(compiled);
    },
    get hasTransform() {
      return "~hasTransform" in this ? this["~hasTransform"] : this["~hasTransform"] = hasTransform(schema);
    },
    get hasRef() {
      return "~hasRef" in this ? this["~hasRef"] : this["~hasRef"] = hasRef(schema);
    },
    "~hasRef": doesHaveRef
  }), compiled;
}, isUnion = (schema) => schema[import_typebox.Kind] === "Union" || !schema.schema && !!schema.anyOf, mergeObjectSchemas = (schemas) => {
  if (schemas.length === 0)
    return {
      schema: void 0,
      notObjects: []
    };
  if (schemas.length === 1)
    return schemas[0].type === "object" ? {
      schema: schemas[0],
      notObjects: []
    } : {
      schema: void 0,
      notObjects: schemas
    };
  let newSchema;
  const notObjects = [];
  let additionalPropertiesIsTrue = !1, additionalPropertiesIsFalse = !1;
  for (const schema of schemas) {
    if (schema.type !== "object") {
      notObjects.push(schema);
      continue;
    }
    if ("additionalProperties" in schema && (schema.additionalProperties === !0 ? additionalPropertiesIsTrue = !0 : schema.additionalProperties === !1 && (additionalPropertiesIsFalse = !0)), !newSchema) {
      newSchema = schema;
      continue;
    }
    newSchema = {
      ...newSchema,
      ...schema,
      properties: {
        ...newSchema.properties,
        ...schema.properties
      },
      required: [...newSchema?.required ?? [], ...schema.required]
    };
  }
  return newSchema && (newSchema.required && (newSchema.required = [...new Set(newSchema.required)]), additionalPropertiesIsFalse ? newSchema.additionalProperties = !1 : additionalPropertiesIsTrue && (newSchema.additionalProperties = !0)), {
    schema: newSchema,
    notObjects
  };
}, getResponseSchemaValidator = (s, {
  models = {},
  modules,
  dynamic = !1,
  normalize = !1,
  additionalProperties = !1,
  validators = [],
  sanitize
}) => {
  if (validators = validators.filter((x) => x), !s) {
    if (!validators?.length) return;
    s = validators[0], validators = validators.slice(1);
  }
  let maybeSchemaOrRecord;
  if (typeof s != "string") maybeSchemaOrRecord = s;
  else if (maybeSchemaOrRecord = // @ts-expect-error private property
  modules && s in modules.$defs ? modules.Import(s) : models[s], !maybeSchemaOrRecord) return;
  if (!maybeSchemaOrRecord) return;
  if (import_typebox.Kind in maybeSchemaOrRecord || "~standard" in maybeSchemaOrRecord)
    return {
      200: getSchemaValidator(
        maybeSchemaOrRecord,
        {
          modules,
          models,
          additionalProperties,
          dynamic,
          normalize,
          coerce: !1,
          additionalCoerce: [],
          validators: validators.map((x) => x[200]),
          sanitize
        }
      )
    };
  const record = {};
  return Object.keys(maybeSchemaOrRecord).forEach((status) => {
    if (isNaN(+status)) return;
    const maybeNameOrSchema = maybeSchemaOrRecord[+status];
    if (typeof maybeNameOrSchema == "string") {
      if (maybeNameOrSchema in models) {
        const schema = models[maybeNameOrSchema];
        if (!schema) return;
        record[+status] = import_typebox.Kind in schema || "~standard" in schema ? getSchemaValidator(schema, {
          modules,
          models,
          additionalProperties,
          dynamic,
          normalize,
          coerce: !1,
          additionalCoerce: [],
          validators: validators.map((x) => x[+status]),
          sanitize
        }) : schema;
      }
      return;
    }
    record[+status] = import_typebox.Kind in maybeNameOrSchema || "~standard" in maybeNameOrSchema ? getSchemaValidator(maybeNameOrSchema, {
      modules,
      models,
      additionalProperties,
      dynamic,
      normalize,
      coerce: !1,
      additionalCoerce: [],
      validators: validators.map((x) => x[+status]),
      sanitize
    }) : maybeNameOrSchema;
  }), record;
};
let _stringToStructureCoercions;
const stringToStructureCoercions = () => (_stringToStructureCoercions || (_stringToStructureCoercions = [
  {
    from: import_type_system.t.Object({}),
    to: () => import_type_system.t.ObjectString({}),
    excludeRoot: !0
  },
  {
    from: import_type_system.t.Array(import_type_system.t.Any()),
    to: () => import_type_system.t.ArrayString(import_type_system.t.Any())
  }
]), _stringToStructureCoercions);
let _queryCoercions;
const queryCoercions = () => (_queryCoercions || (_queryCoercions = [
  {
    from: import_type_system.t.Object({}),
    to: () => import_type_system.t.ObjectString({}),
    excludeRoot: !0
  },
  {
    from: import_type_system.t.Array(import_type_system.t.Any()),
    to: () => import_type_system.t.ArrayQuery(import_type_system.t.Any())
  }
]), _queryCoercions);
let _coercePrimitiveRoot;
const coercePrimitiveRoot = () => (_coercePrimitiveRoot || (_coercePrimitiveRoot = [
  {
    from: import_type_system.t.Number(),
    to: (options) => import_type_system.t.Numeric(options),
    rootOnly: !0
  },
  {
    from: import_type_system.t.Boolean(),
    to: (options) => import_type_system.t.BooleanString(options),
    rootOnly: !0
  }
]), _coercePrimitiveRoot), getCookieValidator = ({
  validator,
  modules,
  defaultConfig = {},
  config,
  dynamic,
  normalize = !1,
  models,
  validators,
  sanitize
}) => {
  let cookieValidator = (
    // @ts-ignore
    validator?.provider ? validator : (
      // @ts-ignore
      getSchemaValidator(validator, {
        modules,
        dynamic,
        models,
        normalize,
        additionalProperties: !0,
        coerce: !0,
        additionalCoerce: stringToStructureCoercions(),
        validators,
        sanitize
      })
    )
  );
  return cookieValidator ? cookieValidator.config = (0, import_utils.mergeCookie)(cookieValidator.config, config) : (cookieValidator = getSchemaValidator(import_type_system.t.Cookie(import_type_system.t.Any()), {
    modules,
    dynamic,
    models,
    additionalProperties: !0,
    validators,
    sanitize
  }), cookieValidator.config = defaultConfig), cookieValidator;
}, unwrapImportSchema = (schema) => schema && schema[import_typebox.Kind] === "Import" && schema.$defs[schema.$ref][import_typebox.Kind] === "Object" ? schema.$defs[schema.$ref] : schema;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  coercePrimitiveRoot,
  getCookieValidator,
  getResponseSchemaValidator,
  getSchemaValidator,
  hasAdditionalProperties,
  hasElysiaMeta,
  hasProperty,
  hasRef,
  hasTransform,
  hasType,
  isOptional,
  isUnion,
  mergeObjectSchemas,
  queryCoercions,
  replaceSchemaType,
  stringToStructureCoercions,
  unwrapImportSchema
});

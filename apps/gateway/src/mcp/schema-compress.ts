/** Soft cap for JSON Schema / tool `description` strings returned to agents. */
export const DESCRIPTION_MAX = 140;

export function truncateDescription(value: string, max = DESCRIPTION_MAX): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function compressValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compressValue);
  }
  if (value && typeof value === "object") {
    return compressObject(value as Record<string, unknown>);
  }
  return value;
}

function humanizedPropName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function compressObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key === "$schema") continue;
    if (key === "$comment") continue;
    if (key === "markdownDescription") continue;
    if (key === "examples" || key === "example") continue;

    if (key === "additionalProperties" && value === true) continue;

    if (key === "title" && typeof value === "string") {
      continue;
    }

    if (key === "description" && typeof value === "string") {
      out[key] = truncateDescription(value);
      continue;
    }

    if (key === "enum" && Array.isArray(value)) {
      out[key] = value.slice();
      continue;
    }

    // default/const hold example data, not schema. Do not rewrite nested keys.
    if (key === "default" || key === "const") {
      out[key] = structuredClone(value);
      continue;
    }

    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        const compressed = compressValue(propSchema);
        if (
          compressed &&
          typeof compressed === "object" &&
          !Array.isArray(compressed)
        ) {
          const prop = { ...(compressed as Record<string, unknown>) };
          if (
            typeof prop.title === "string" &&
            prop.title === humanizedPropName(propName)
          ) {
            delete prop.title;
          }
          props[propName] = prop;
        } else {
          props[propName] = compressed;
        }
      }
      out[key] = props;
      continue;
    }

    out[key] = compressValue(value);
  }

  return out;
}

/**
 * Shrink a tool `inputSchema` for agent-facing responses (token savings).
 * Does not mutate the input; preserves `required`, types, property names, and full enums.
 */
export function compressToolSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {};
  }
  return compressObject(schema as Record<string, unknown>);
}

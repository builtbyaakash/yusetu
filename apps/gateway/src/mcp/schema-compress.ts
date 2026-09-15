/** Soft cap for JSON Schema `description` strings returned to agents. */
const DESCRIPTION_MAX = 140;
/** Max enum values kept in compressed schemas. */
const ENUM_MAX = 12;

function truncateDescription(value: string): string {
  if (value.length <= DESCRIPTION_MAX) return value;
  return `${value.slice(0, DESCRIPTION_MAX - 1)}…`;
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

function compressObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key === "$schema") continue;

    if (key === "additionalProperties" && value === true) continue;

    if (key === "description" && typeof value === "string") {
      out[key] = truncateDescription(value);
      continue;
    }

    if (key === "enum" && Array.isArray(value)) {
      if (value.length > ENUM_MAX) {
        out[key] = value.slice(0, ENUM_MAX);
        out["x-yusetu-enum-truncated"] = true;
      } else {
        out[key] = value.slice();
      }
      continue;
    }

    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(
        value as Record<string, unknown>,
      )) {
        props[propName] = compressValue(propSchema);
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
 * Does not mutate the input; preserves `required`, types, and property names.
 */
export function compressToolSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {};
  }
  return compressObject(schema as Record<string, unknown>);
}

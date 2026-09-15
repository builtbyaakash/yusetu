/** Build a sample JSON object from a JSON Schema (MCP tool inputSchema). */
export function sampleArgsFromSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return {};
  }
  return sampleFromNode(schema as JsonSchema) as Record<string, unknown>;
}

export function formatSampleArgs(schema: unknown): string {
  return `${JSON.stringify(sampleArgsFromSchema(schema), null, 2)}\n`;
}

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  required?: string[];
  enum?: unknown[];
  examples?: unknown[];
  example?: unknown;
  default?: unknown;
  description?: string;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  const?: unknown;
};

function primaryType(type: string | string[] | undefined): string | undefined {
  if (!type) return undefined;
  return Array.isArray(type) ? type.find((t) => t !== "null") : type;
}

function sampleFromNode(schema: JsonSchema): unknown {
  if (schema.example !== undefined) return schema.example;
  if (schema.examples && schema.examples.length > 0) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];

  const merged = mergeComposed(schema);
  const t = primaryType(merged.type);

  if (t === "object" || merged.properties) {
    const props = merged.properties ?? {};
    const required = new Set(merged.required ?? Object.keys(props));
    const out: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(props)) {
      if (!required.has(key) && Object.keys(props).length > 4) continue;
      out[key] = sampleFromNode(prop);
    }
    return out;
  }

  if (t === "array") {
    const items = Array.isArray(merged.items) ? merged.items[0] : merged.items;
    return items ? [sampleFromNode(items)] : [];
  }

  if (t === "string") {
    if (merged.description) return `<${merged.description.slice(0, 40)}>`;
    return "string";
  }
  if (t === "number" || t === "integer") return 0;
  if (t === "boolean") return false;
  if (t === "null") return null;

  // Fallback: treat as object if we have nothing else
  if (merged.properties) {
    return sampleFromNode({ ...merged, type: "object" });
  }
  return {};
}

function mergeComposed(schema: JsonSchema): JsonSchema {
  const parts = [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  if (parts.length === 0) return schema;
  const first = parts[0]!;
  return {
    ...schema,
    ...first,
    properties: { ...first.properties, ...schema.properties },
    required: schema.required ?? first.required,
    type: schema.type ?? first.type,
  };
}

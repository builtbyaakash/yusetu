import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compressToolSchema, truncateDescription } from "../mcp/schema-compress.js";
import { estimateDirectToolTokens, estimateToolDescriptorTokens } from "./tokens.js";
import { metaToolDescriptors } from "../mcp/meta-tools.js";

describe("compressToolSchema", () => {
  it("preserves full enums and drops examples/titles/$schema", () => {
    const enumVals = Array.from({ length: 20 }, (_, i) => `v${i}`);
    const out = compressToolSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      title: "Root",
      examples: [{ a: 1 }],
      required: ["status"],
      properties: {
        status: {
          type: "string",
          enum: enumVals,
          title: "Status",
          description: "x".repeat(200),
          examples: ["v0"],
        },
      },
    });

    assert.equal(out.$schema, undefined);
    assert.equal(out.examples, undefined);
    assert.equal(out.title, undefined);
    assert.deepEqual(out.required, ["status"]);
    const status = (out.properties as Record<string, Record<string, unknown> | undefined>)
      .status;
    assert.ok(status);
    assert.deepEqual(status.enum, enumVals);
    assert.equal(status.examples, undefined);
    assert.equal((status.description as string).length, 140);
  });

  it("leaves default and const payloads untouched", () => {
    const long = "keep-me-long-".repeat(20);
    const out = compressToolSchema({
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "x".repeat(200),
          default: { description: long },
          const: { description: long },
        },
      },
    });
    const note = (out.properties as Record<string, Record<string, unknown>>)
      .note;
    assert.deepEqual(note.default, { description: long });
    assert.deepEqual(note.const, { description: long });
    assert.equal((note.description as string).length, 140);
  });
});

describe("truncateDescription", () => {
  it("caps at 140 including ellipsis", () => {
    const s = truncateDescription("a".repeat(200));
    assert.equal(s.length, 140);
    assert.ok(s.endsWith("…"));
  });
});

describe("estimateDirectToolTokens", () => {
  it("prices originalName without slug prefix", () => {
    const tool = {
      upstreamId: "u1",
      slug: "linear",
      originalName: "list_issues",
      exposedName: "linear__list_issues",
      description: "List issues",
      inputSchema: { type: "object", properties: {} },
    };
    const honest = estimateDirectToolTokens(tool);
    const prefixed = estimateToolDescriptorTokens(
      "linear__list_issues",
      "[linear] List issues",
      tool.inputSchema,
    );
    assert.ok(honest < prefixed);
    assert.equal(
      honest,
      estimateToolDescriptorTokens("list_issues", "List issues", tool.inputSchema),
    );
  });
});

describe("metaToolDescriptors", () => {
  it("keeps meta tools/list under 520 estimated tokens", () => {
    const total = metaToolDescriptors().reduce(
      (sum, t) =>
        sum +
        estimateToolDescriptorTokens(t.name, t.description ?? "", t.inputSchema),
      0,
    );
    assert.ok(total <= 520, `meta catalog is ${total} tokens`);
  });
});

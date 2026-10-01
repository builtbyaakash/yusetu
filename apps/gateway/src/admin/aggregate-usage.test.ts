import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateUsage,
  estimateMetaToolsListTokens,
} from "./aggregate-usage.js";

describe("aggregateUsage", () => {
  const upstreams = [
    { slug: "linear", name: "Linear" },
    { slug: "github", name: "GitHub" },
  ];
  const catalogBySlug = new Map([
    ["linear", { toolCount: 10, catalogTokens: 5000 }],
    ["github", { toolCount: 20, catalogTokens: 8000 }],
  ]);
  const currentDirect = 13_000;

  it("sums stored tools_list via and ifDirect (N lists → N × paired totals)", () => {
    const events = [
      {
        kind: "tools_list",
        mcpSlug: null,
        tokensViaGateway: 400,
        tokensIfDirect: 12_000,
        callCount: 1,
      },
      {
        kind: "tools_list",
        mcpSlug: null,
        tokensViaGateway: 400,
        tokensIfDirect: 12_000,
        callCount: 1,
      },
      {
        kind: "tool_call",
        mcpSlug: "linear",
        tokensViaGateway: 100,
        tokensIfDirect: 100,
        callCount: 1,
      },
    ];

    const out = aggregateUsage({
      toolPresentation: "meta",
      events,
      upstreamRows: upstreams,
      catalogBySlug,
      catalogToolCount: 30,
      currentDirectCatalogTokens: currentDirect,
    });

    assert.equal(out.toolsListCount, 2);
    assert.equal(out.catalogTokensVia, 800);
    assert.equal(out.catalogTokensIfDirect, 24_000);
    assert.equal(out.catalogTokensDelta, 23_200);
    assert.equal(out.catalogFromLiveSnapshot, false);
    // Live snapshot must not replace stored ifDirect.
    assert.notEqual(out.catalogTokensIfDirect, currentDirect);
  });

  it("does not invent historical catalog savings when tools_list is missing", () => {
    const events = [
      {
        kind: "tool_call",
        mcpSlug: "linear",
        tokensViaGateway: 50,
        tokensIfDirect: 50,
        callCount: 1,
      },
    ];

    const out = aggregateUsage({
      toolPresentation: "meta",
      events,
      upstreamRows: upstreams,
      catalogBySlug,
      catalogToolCount: 30,
      currentDirectCatalogTokens: currentDirect,
    });

    assert.equal(out.toolsListCount, 0);
    assert.equal(out.catalogTokensVia, 0);
    assert.equal(out.catalogTokensIfDirect, 0);
    assert.equal(out.catalogFromLiveSnapshot, true);
    assert.equal(out.currentOpportunity.ifDirect, currentDirect);
    assert.equal(out.currentOpportunity.via, estimateMetaToolsListTokens());
  });

  it("subtracts discovery overhead from net and leaves get_tool out of catalog ifDirect", () => {
    const events = [
      {
        kind: "tools_list",
        mcpSlug: null,
        tokensViaGateway: 400,
        tokensIfDirect: 10_000,
        callCount: 1,
      },
      {
        kind: "get_tool",
        mcpSlug: "linear",
        tokensViaGateway: 200,
        tokensIfDirect: 0,
        callCount: 1,
      },
      {
        kind: "search_tools",
        mcpSlug: null,
        tokensViaGateway: 80,
        tokensIfDirect: 0,
        callCount: 1,
      },
    ];

    const out = aggregateUsage({
      toolPresentation: "meta",
      events,
      upstreamRows: upstreams,
      catalogBySlug,
      catalogToolCount: 30,
      currentDirectCatalogTokens: currentDirect,
    });

    assert.equal(out.catalogTokensIfDirect, 10_000);
    assert.equal(out.discoveryOverheadVia, 280);
    assert.equal(out.netTokensSaved, 10_000 - 400 - 280);
    assert.equal(out.byMcp.find((r) => r.slug === "linear")?.tokensIfDirect, 0);
  });

  it("keeps signed net when discovery exceeds catalog delta", () => {
    const events = [
      {
        kind: "tools_list",
        mcpSlug: null,
        tokensViaGateway: 800,
        tokensIfDirect: 900,
        callCount: 1,
      },
      {
        kind: "list_tools",
        mcpSlug: "linear",
        tokensViaGateway: 500,
        tokensIfDirect: 0,
        callCount: 1,
      },
    ];

    const out = aggregateUsage({
      toolPresentation: "meta",
      events,
      upstreamRows: upstreams,
      catalogBySlug,
      catalogToolCount: 30,
      currentDirectCatalogTokens: currentDirect,
    });

    assert.equal(out.catalogTokensDelta, 100);
    assert.equal(out.netTokensSaved, 100 - 500);
    assert.ok(out.netTokensSaved < 0);
  });

  it("shared overhead exposureVia equals catalog via", () => {
    const events = [
      {
        kind: "tools_list",
        mcpSlug: null,
        tokensViaGateway: 412,
        tokensIfDirect: 9000,
        callCount: 1,
      },
    ];
    const out = aggregateUsage({
      toolPresentation: "meta",
      events,
      upstreamRows: upstreams,
      catalogBySlug,
      catalogToolCount: 30,
      currentDirectCatalogTokens: currentDirect,
    });
    assert.equal(out.sharedOverhead.exposureVia, out.catalogTokensVia);
  });
});

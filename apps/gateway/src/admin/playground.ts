import type { Context } from "hono";
import { PlaygroundCallSchema } from "@yusetu/shared";
import type { ToolRouter } from "../mcp/router.js";

export function createPlaygroundHandler(router: ToolRouter) {
  return async (c: Context) => {
    const parsed = PlaygroundCallSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.flatten() },
        400,
      );
    }

    const started = Date.now();
    const result = await router.callTool(
      parsed.data.tool,
      parsed.data.arguments as Record<string, unknown>,
    );
    const latencyMs = Date.now() - started;
    const ok = !result.isError;

    return c.json({
      ok,
      result: ok ? result : undefined,
      error: ok
        ? undefined
        : result.content
            ?.map((part) =>
              part.type === "text" ? part.text : JSON.stringify(part),
            )
            .join("\n") || "Tool call failed",
      latencyMs,
    });
  };
}

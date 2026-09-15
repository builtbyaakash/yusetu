/** Public MCP endpoint URLs for SDKs / IDEs. */
export function mcpGatewayEndpoints() {
  const { protocol, hostname, port } = window.location;
  // Vite dev proxies API but MCP clients talk to the gateway directly.
  const gatewayPort =
    port === "5173" || port === "4173" ? "8080" : port || (protocol === "https:" ? "443" : "80");
  const showPort =
    (protocol === "http:" && gatewayPort !== "80") ||
    (protocol === "https:" && gatewayPort !== "443");
  const origin = `${protocol}//${hostname}${showPort ? `:${gatewayPort}` : ""}`;

  return {
    origin,
    streamableHttp: `${origin}/mcp`,
    health: `${origin}/api/health`,
    oauthProtectedResource: `${origin}/.well-known/oauth-protected-resource`,
    oauthAuthorizationServer: `${origin}/.well-known/oauth-authorization-server`,
    oauthAuthorize: `${origin}/oauth/authorize`,
    oauthToken: `${origin}/oauth/token`,
    oauthRegister: `${origin}/oauth/register`,
  };
}

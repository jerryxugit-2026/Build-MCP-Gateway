// Copy to endpoints.mjs and point each entry at a stdio MCP server wrapper script.
// Rule learned the hard way: never put a STATEFUL server (a live browser) in this shared table —
// two agents navigating the same tab corrupt each other. Give stateful servers one stdio instance per client.
const bin = process.env.MCP_BIN ?? './bin';
const production = [
  { name: 'office', port: 8810, wrapper: `${bin}/office-mcp.sh`, note: 'stateless; safe to share' },
  { name: 'calendar', port: 8811, wrapper: `${bin}/calendar-mcp.sh`, note: 'credentials live in the wrapper env, never here' },
];
// Test hook: GW_ENDPOINTS_OVERRIDE='[{"name":"x","port":9900,"wrapper":"/bin/sh","args":[...]}]'
export const endpoints = process.env.GW_ENDPOINTS_OVERRIDE
  ? JSON.parse(process.env.GW_ENDPOINTS_OVERRIDE)
  : production;

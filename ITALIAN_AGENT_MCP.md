# Italian Agent MCP Integration Guide

This document explains how to integrate a Model Context Protocol (MCP) server with the Italian conversation agent.

## Overview

The Italian agent has been enhanced to support integration with streamable HTTP MCP servers. MCP (Model Context Protocol) allows the agent to access external tools and data sources through a standardized protocol.

**Browser Support:** The implementation includes a Next.js API proxy route (`/api/mcp`) that forwards MCP requests from browser clients to the actual MCP server. This allows full MCP functionality in browser environments by routing through server-side code, avoiding browser shim limitations.

## What is MCP?

MCP is an open protocol that standardizes how applications expose tools, data sources, and context to large language models. It enables agents to discover and call tools in a standard way, whether they're exposed via HTTP, on-disk, or via subprocesses.

## Prerequisites

### Package Version

**⚠️ IMPORTANT LIMITATION:** MCP support requires `@openai/agents` version 0.1.0 or higher. However, **versions 0.1.0+ have a known bug** that causes SDP parsing errors (`Failed to parse SessionDescription. { Expect line: v=`), preventing WebRTC connections from working.

**Current Status:**
- The project currently uses version **0.3.9** (which supports MCP)
- Version **0.0.5 does NOT support MCP** (the `mcpServers` property doesn't exist)
- Versions **0.1.0+ support MCP** but may have the SDP parsing bug that breaks WebRTC connections
- **⚠️ IMPORTANT:** Version 0.3.9 may still have the SDP parsing bug - testing required

**Workaround Options:**
1. **Wait for OpenAI to fix the SDP bug** in a future SDK release, then upgrade to that version
2. **Monitor the GitHub issue**: [openai/openai-agents-js#463](https://github.com/openai/openai-agents-js/issues/463) for updates
3. **Test newer versions periodically** to see if the bug has been resolved

**To upgrade (when the bug is fixed):**
```bash
npm install @openai/agents@latest
```

After upgrading, verify the version:
```bash
npm list @openai/agents
```

## Configuration

### Environment Variables

Set the MCP server URL using the server-side environment variable:

- `MCP_SERVER_URL` - Server-side environment variable (required)

**Example `.env` file:**
```env
MCP_SERVER_URL=https://your-mcp-server.com/api
```

**Note:** Only `MCP_SERVER_URL` is needed. The proxy route automatically handles browser-to-server communication. You do not need `NEXT_PUBLIC_MCP_SERVER_URL`.

### MCP Server Requirements

Your MCP server must:
- Support streamable HTTP transport
- Expose tools via the MCP protocol
- Be accessible from the Next.js server (not required to be accessible from the browser)

### Browser Support via Proxy

**Browser MCP Support:** The implementation includes a Next.js API proxy route that enables full MCP functionality in browser environments. The proxy route (`/api/mcp/[...path]`) forwards all MCP protocol requests from the browser client to the actual MCP server running server-side.

**How it works:**
- Browser clients connect to `/api/mcp` (the proxy route)
- The proxy route forwards requests to the actual MCP server (configured via `MCP_SERVER_URL`)
- All MCP protocol headers are preserved (`MCP-Protocol-Version`, `Mcp-Session-Id`, etc.)
- Both POST (JSON-RPC) and GET (SSE streams) requests are supported
- Responses and SSE streams are forwarded back to the browser client

This approach avoids browser shim limitations by routing all MCP communication through server-side code.

## Implementation Details

### Files Modified

1. **`src/app/agentConfigs/italianConversation.ts`**
   - Added MCP server integration
   - Created async initialization functions
   - Added lifecycle management
   - Updated to use proxy route in browser environments

2. **`src/app/api/mcp/[...path]/route.ts`** (new file)
   - Next.js API route that proxies MCP requests
   - Handles POST requests (JSON-RPC messages)
   - Handles GET requests (SSE streams)
   - Preserves MCP protocol headers
   - Forwards responses and streams back to clients

### Key Functions

#### `createItalianAgentWithMCP(mcpServerUrl?: string)`

Creates and returns an Italian agent with MCP server connected (server-side) or without MCP (browser fallback).

**Parameters:**
- `mcpServerUrl` (optional): Override the MCP server URL from environment variables

**Returns:**
- `Promise<RealtimeAgent>`: Agent instance with MCP tools available (server-side) or without MCP (browser)

**Behavior:**
- **Browser environments**: Returns agent with MCP servers connected via proxy route (`/api/mcp`)
- **Server-side environments**: Returns agent with MCP servers connected directly to `MCP_SERVER_URL`

**Example:**
```typescript
import { createItalianAgentWithMCP } from '@/app/agentConfigs/italianConversation';

const agent = await createItalianAgentWithMCP('https://my-mcp-server.com/api');
```

#### `getItalianConversationScenarioWithMCP(mcpServerUrl?: string)`

Returns the full scenario array with MCP-enabled agent.

**Returns:**
- `Promise<RealtimeAgent[]>`: Array containing the Italian agent with MCP

**Example:**
```typescript
import { getItalianConversationScenarioWithMCP } from '@/app/agentConfigs/italianConversation';

const scenario = await getItalianConversationScenarioWithMCP();
```

#### `disconnectMCP()`

Cleanup function to properly disconnect the MCP server.

**Example:**
```typescript
import { disconnectMCP } from '@/app/agentConfigs/italianConversation';

await disconnectMCP();
```

## Usage in App.tsx

To use the MCP-enabled Italian agent, you'll need to update the connection logic in `App.tsx`:

```typescript
import { getItalianConversationScenarioWithMCP } from '@/app/agentConfigs/italianConversation';

const connectToRealtime = async () => {
  const agentSetKey = searchParams.get("agentConfig") || "default";
  
  // Handle Italian conversation with MCP
  if (agentSetKey === 'italianConversation') {
    if (sessionStatus !== "DISCONNECTED") return;
    setSessionStatus("CONNECTING");

    try {
      const EPHEMERAL_KEY = await fetchEphemeralKey();
      if (!EPHEMERAL_KEY) return;

      // Get scenario with MCP
      const agents = await getItalianConversationScenarioWithMCP();
      
      // Reorder agents if needed
      const reorderedAgents = [...agents];
      const idx = reorderedAgents.findIndex((a) => a.name === selectedAgentName);
      if (idx > 0) {
        const [agent] = reorderedAgents.splice(idx, 1);
        reorderedAgents.unshift(agent);
      }

      const guardrail = createModerationGuardrail('Assistant');

      await connect({
        getEphemeralKey: async () => EPHEMERAL_KEY,
        initialAgents: reorderedAgents,
        audioElement: sdkAudioElement,
        outputGuardrails: [guardrail],
        extraContext: {
          addTranscriptBreadcrumb,
        },
      });
    } catch (err) {
      console.error("Error connecting via SDK:", err);
      setSessionStatus("DISCONNECTED");
    }
    return;
  }
  
  // ... rest of existing connection logic
};
```

## Agent Instructions

The agent's instructions have been updated to include guidance on using MCP tools:

- The agent will use tools provided by the MCP server when appropriate
- It will explain actions in Italian before using tools
- It will inform the user if a tool call might take time

## Browser Environment Support

**Browser MCP Support:** MCP servers are now **fully supported in browser environments** via the proxy route implementation.

### How Browser MCP Works

When running in a browser environment:
- The agent automatically uses the proxy route (`/api/mcp`) instead of connecting directly to the MCP server
- All MCP protocol requests are forwarded through the Next.js server
- The proxy route handles both JSON-RPC messages (POST) and SSE streams (GET)
- MCP protocol headers are preserved and forwarded correctly
- Full MCP functionality is available, including tool discovery and execution

### Server-Side MCP Support

MCP servers also work fully in server-side environments (Node.js):
- Direct connection to `MCP_SERVER_URL` (no proxy needed)
- The `connect()` method is called explicitly
- `listTools()` and other MCP methods work correctly
- Full MCP functionality is available

## Error Handling

The implementation includes robust error handling:

- **Browser environments**: If MCP server URL is not configured, throws an error with clear message
- **Browser environments**: If proxy route fails to connect to MCP server, returns 502 Bad Gateway
- **Server-side environments**: If the MCP server URL is not configured, throws an error with clear message
- **Server-side environments**: If connection to the MCP server fails, throws an error with connection details
- All errors are logged to the console for debugging
- Proxy route errors are returned with appropriate HTTP status codes

## MCP Server Configuration Options

The MCP server is configured with these options:

```typescript
const mcpServer = new MCPServerStreamableHttp({
  url: serverUrl,
  name: 'ItalianAgentMCP',
  cacheToolsList: true,              // Cache tools list for better performance
  clientSessionTimeoutSeconds: 60,    // Session timeout
});
```

### Available Options

- `url`: The MCP server endpoint URL (required)
- `name`: A friendly name for the server (optional)
- `cacheToolsList`: Whether to cache the tools list (default: true)
- `clientSessionTimeoutSeconds`: Session timeout in seconds (default: 60)

## Testing

1. **Set up environment variable:**
   ```bash
   export MCP_SERVER_URL=https://your-mcp-server.com/api
   ```

2. **Start the development server:**
   ```bash
   npm run dev
   ```

3. **Select the Italian conversation scenario** from the dropdown

4. **Verify MCP connection:**
   - Check browser console for connection logs
   - Try using a tool that your MCP server provides
   - The agent should be able to call MCP tools during conversation

## Troubleshooting

### Import Errors

If you see errors like `Module '"@openai/agents"' has no exported member 'MCPServerStreamableHttp'`:

1. **Upgrade the package:**
   ```bash
   npm install @openai/agents@latest
   ```

2. **Verify the import:**
   ```typescript
   import { MCPServerStreamableHttp } from '@openai/agents';
   ```

3. **Check TypeScript types:**
   ```bash
   npm install --save-dev @types/node
   ```

### MCP Server Not Connecting

- Verify the `MCP_SERVER_URL` environment variable is set correctly (server-side only)
- Check that the MCP server is accessible from the Next.js server (not required from browser)
- Review browser console for connection errors
- Check Next.js server logs for proxy route errors
- Ensure the MCP server supports streamable HTTP transport
- Verify the proxy route is accessible at `/api/mcp`

### Tools Not Available

- Verify the MCP server is exposing tools correctly
- Check that tools are listed when calling `list_tools()` on your MCP server
- Review the agent's instructions to ensure it knows about available tools

### Proxy Route Issues

**Browser Environments:**
- If the proxy route returns 500, check that `MCP_SERVER_URL` is configured server-side
- If the proxy route returns 502, the MCP server may be unreachable from the Next.js server
- Check Next.js server logs for detailed error messages
- Verify the MCP server URL format is correct (should be a full URL with protocol)

**Server-Side Environments:**
- If MCP connection fails, an error is thrown with details about the failure
- The error is displayed to the user via `window.alert()` (if in a browser context)
- The session status is set to "DISCONNECTED" to allow retry

**Note:** The proxy route automatically handles browser-to-server communication. No additional client-side configuration is needed beyond setting `MCP_SERVER_URL` on the server.

## Next Steps

1. **Configure your MCP server URL** in environment variables (`MCP_SERVER_URL`)
2. **Test the integration** with your MCP server (works in both browser and server environments)
3. **Customize agent instructions** if needed for your specific MCP tools
4. **Monitor proxy route logs** if you encounter connection issues

## Architecture Diagram

```
Browser Client
    ↓
Next.js API Proxy (/api/mcp)
    ↓
External MCP Server (MCP_SERVER_URL)
```

The proxy route handles:
- POST requests → JSON-RPC messages
- GET requests → SSE streams
- Header forwarding (MCP-Protocol-Version, Mcp-Session-Id, etc.)
- Response streaming back to browser

## Additional Resources

- [OpenAI Agents SDK MCP Documentation](https://openai.github.io/openai-agents-js/guides/mcp/)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [OpenAI Agents SDK Documentation](https://github.com/openai/openai-agents-js)

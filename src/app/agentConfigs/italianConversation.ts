import {
  RealtimeAgent,
} from '@openai/agents/realtime';
import { MCPServerStreamableHttp } from '@openai/agents';

export const italianAgent = new RealtimeAgent({
  name: 'italianAgent',
  voice: 'sage',
  instructions: `
# Language Policy
- CRITICAL: You MUST respond exclusively in Italian (Italiano). Never switch to other languages under any circumstances.
- If the user speaks in another language, politely acknowledge by saying "Mi dispiace, posso comunicare solo in italiano" (I'm sorry, I can only communicate in Italian) and continue the conversation in Italian.
- Use natural, conversational Italian appropriate for friendly dialogue.

# Audio-Only Conversation
- This is an audio-only conversation. You are speaking directly to the user, not writing text.
- NEVER use emojis, symbols, or any visual elements in your responses (no :), :(, ❤️, →, *, etc.).
- Express emotions and tone through your words and voice, not through symbols.
- Use natural spoken language as if you are having a face-to-face conversation.

# Conversational Guidelines
- You are a friendly, conversational assistant.
- Engage in natural, flowing conversations with the user.
- Be warm, approachable, and maintain a friendly tone.
- Keep responses concise and appropriate for voice interaction - avoid long lists or overly complex explanations.
- Ask follow-up questions to keep the conversation engaging.
- If the user asks about topics you cannot help with, politely explain your limitations in Italian.

# General Behavior
- Greet the user warmly when the conversation starts.
- Respond naturally to questions and comments.
- Show interest in what the user is saying.
- Maintain a positive, helpful demeanor throughout the conversation.
`,
  handoffs: [],
  tools: [],
  handoffDescription: 'Agente conversazionale che parla solo italiano',
});

// MCP Server instance for cleanup
let mcpServerInstance: MCPServerStreamableHttp | null = null;

/**
 * Gets the MCP server URL from environment variables.
 * In browser environments, uses the Next.js API proxy route.
 * In server-side environments, uses the direct MCP server URL.
 * 
 * @param overrideUrl - Optional URL to override environment variables
 * @returns The MCP server URL or null if not configured
 */
function getMCPServerUrl(overrideUrl?: string): string | null {
  if (overrideUrl) {
    return overrideUrl;
  }
  
  // In browser environments, use the proxy route
  if (typeof window !== 'undefined') {
    // Use the Next.js API proxy route to avoid browser shim limitations
    return '/api/mcp';
  }
  
  // In server-side environments, use the direct MCP server URL
  if (process.env.MCP_SERVER_URL) {
    return process.env.MCP_SERVER_URL;
  }
  
  return null;
}

/**
 * Creates a browser-compatible wrapper for MCP server that intercepts method calls
 * and routes them through the proxy API when browser shim throws "Method not implemented"
 * 
 * @param baseServer - The MCPServerStreamableHttp instance to wrap
 * @returns A Proxy-wrapped version that routes failed method calls through the proxy API
 */
function createBrowserMCPWrapper(baseServer: MCPServerStreamableHttp): MCPServerStreamableHttp {
  return new Proxy(baseServer, {
    get(target, prop, receiver) {
      const originalValue = Reflect.get(target, prop, receiver);
      
      // Wrap ALL functions to intercept method calls
      if (typeof originalValue === 'function') {
        return async function(...args: any[]) {
          try {
            // Try calling the original method first
            const result = await originalValue.apply(target, args);
            return result;
          } catch (error: any) {
            
            // If it throws "Method not implemented", route through our proxy API
            if (error?.message?.includes('Method not implemented') || 
                error?.message?.includes('not implemented')) {
              
              if (prop === 'listTools') {
                // Call our proxy API to list tools
                const response = await fetch('/api/mcp', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream',
                    'MCP-Protocol-Version': '2024-11-05',
                  },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/list',
                    params: {},
                  }),
                });
                
                if (!response.ok) {
                  throw new Error(`Failed to list tools via proxy: ${response.statusText}`);
                }
                
                // Check if response is SSE stream or JSON
                const contentType = response.headers.get('Content-Type');
                if (contentType?.includes('text/event-stream')) {
                  // Parse SSE stream to extract JSON-RPC response
                  const reader = response.body?.getReader();
                  const decoder = new TextDecoder();
                  let buffer = '';
                  
                  if (!reader) {
                    throw new Error('No response body reader available');
                  }
                  
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    
                    // Look for JSON-RPC response in SSE format
                    // SSE format: "event: message\ndata: {...}\n\n"
                    const jsonMatch = buffer.match(/data:\s*(\{[\s\S]*?\})\s*\n\n/);
                    if (jsonMatch) {
                      try {
                        const data = JSON.parse(jsonMatch[1]);
                        return data.result?.tools || [];
                      } catch (parseError) {
                        throw new Error(`Failed to parse SSE response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
                      }
                    }
                  }
                  
                  throw new Error('No JSON-RPC response found in SSE stream');
                } else {
                  // Handle JSON response
                  const data = await response.json();
                  return data.result?.tools || [];
                }
              } else if (prop === 'connect') {
                // connect() is handled automatically by the SDK, just return success
                return Promise.resolve();
              } else if (prop === 'invalidateToolsCache') {
                // Cache invalidation - just return success
                return Promise.resolve();
              } else if (prop === 'callTool') {
                // Handle tool execution calls
                // callTool(toolName, params) -> tools/call JSON-RPC method
                const [toolName, toolParams] = args;
                
                const response = await fetch('/api/mcp', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json, text/event-stream',
                    'MCP-Protocol-Version': '2024-11-05',
                  },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: Date.now(),
                    method: 'tools/call',
                    params: {
                      name: toolName,
                      arguments: toolParams || {},
                    },
                  }),
                });
                
                // #region debug log
                fetch('http://127.0.0.1:7250/ingest/ee3f4ff0-1711-48aa-b77d-da602a66cb6e',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'italianConversation.ts:177',message:'callTool: proxy response received',data:{status:response.status,statusText:response.statusText,ok:response.ok,contentType:response.headers.get('Content-Type')},timestamp:Date.now(),sessionId:'debug-session',runId:'run3',hypothesisId:'F'})}).catch(()=>{});
                // #endregion
                
                if (!response.ok) {
                  throw new Error(`Failed to call tool via proxy: ${response.statusText}`);
                }
                
                // Check if response is SSE stream or JSON
                const contentType = response.headers.get('Content-Type');
                if (contentType?.includes('text/event-stream')) {
                  // Parse SSE stream to extract JSON-RPC response
                  const reader = response.body?.getReader();
                  const decoder = new TextDecoder();
                  let buffer = '';
                  
                  if (!reader) {
                    throw new Error('No response body reader available');
                  }
                  
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    buffer += decoder.decode(value, { stream: true });
                    
                    // Look for JSON-RPC response in SSE format
                    const jsonMatch = buffer.match(/data:\s*(\{[\s\S]*?\})\s*\n\n/);
                    if (jsonMatch) {
                      try {
                        const data = JSON.parse(jsonMatch[1]);
                        if (data.error) {
                          throw new Error(data.error.message || 'Tool call failed');
                        }
                        return data.result;
                      } catch (parseError) {
                        throw new Error(`Failed to parse SSE response: ${parseError instanceof Error ? parseError.message : 'Unknown error'}`);
                      }
                    }
                  }
                  
                  throw new Error('No JSON-RPC response found in SSE stream');
                } else {
                  // Handle JSON response
                  const data = await response.json();
                  if (data.error) {
                    throw new Error(data.error.message || 'Tool call failed');
                  }
                  return data.result;
                }
              } else {
                // For any other method that throws "Method not implemented", re-throw
                throw error;
              }
            }
            // Re-throw if it's a different error
            throw error;
          }
        };
      }
      
      // Return original value for non-function properties or other methods
      return originalValue;
    },
  }) as MCPServerStreamableHttp;
}

/**
 * Initializes and connects to the MCP server.
 * 
 * @param mcpServerUrl - Optional URL to override environment variables
 * @returns The connected MCP server instance
 * @throws Error if URL is not configured or connection fails
 */
async function initializeMCPServer(mcpServerUrl?: string): Promise<MCPServerStreamableHttp> {
  const serverUrl = getMCPServerUrl(mcpServerUrl);
  
  if (!serverUrl) {
    throw new Error(
      "MCP server URL not configured. Please set MCP_SERVER_URL or NEXT_PUBLIC_MCP_SERVER_URL environment variable."
    );
  }
  
  try {
    const mcpServer = new MCPServerStreamableHttp({
      url: serverUrl,
      name: 'ItalianAgentMCP',
      cacheToolsList: true,
      clientSessionTimeoutSeconds: 60,
    });
    
    // In browser environments, wrap the server to intercept method calls and route through proxy
    if (typeof window !== 'undefined') {
      const wrappedServer = createBrowserMCPWrapper(mcpServer);
      mcpServerInstance = wrappedServer;
      return wrappedServer;
    }
    
    // Server-side: Explicitly connect and return unwrapped server
    await mcpServer.connect();
    mcpServerInstance = mcpServer;
    return mcpServer;
  } catch (error) {
    const errorMessage = error instanceof Error 
      ? error.message 
      : "Unknown error occurred";
    
    throw new Error(
      `Failed to connect to MCP server at ${serverUrl}: ${errorMessage}`
    );
  }
}

/**
 * Agent instructions with MCP tools section
 */
const agentInstructionsWithMCP = `
# Language Policy
- CRITICAL: You MUST respond exclusively in Italian (Italiano). Never switch to other languages under any circumstances.
- If the user speaks in another language, politely acknowledge by saying "Mi dispiace, posso comunicare solo in italiano" (I'm sorry, I can only communicate in Italian) and continue the conversation in Italian.
- Use natural, conversational Italian appropriate for friendly dialogue.

# Audio-Only Conversation
- This is an audio-only conversation. You are speaking directly to the user, not writing text.
- NEVER use emojis, symbols, or any visual elements in your responses (no :), :(, ❤️, →, *, etc.).
- Express emotions and tone through your words and voice, not through symbols.
- Use natural spoken language as if you are having a face-to-face conversation.

# Conversational Guidelines
- You are a friendly, conversational assistant.
- Engage in natural, flowing conversations with the user.
- Be warm, approachable, and maintain a friendly tone.
- Keep responses concise and appropriate for voice interaction - avoid long lists or overly complex explanations.
- Ask follow-up questions to keep the conversation engaging.
- If the user asks about topics you cannot help with, politely explain your limitations in Italian.

# MCP Tools Usage
- You have access to external tools provided by the MCP server.
- When you need to use a tool, explain what you're doing in Italian before using it.
- For example: "Sto controllando le informazioni per te..." (I'm checking the information for you...)
- If a tool call might take some time, inform the user: "Questo potrebbe richiedere un momento..." (This might take a moment...)
- Always explain the results of tool calls in Italian in a natural, conversational way.
- Before executing a query via the MCP server always ask confirmation from the user in Italian.

# General Behavior
- Greet the user warmly when the conversation starts.
- Respond naturally to questions and comments.
- Show interest in what the user is saying.
- Maintain a positive, helpful demeanor throughout the conversation.
`;

/**
 * Creates an Italian agent with MCP server connected (or without MCP if connection fails).
 * 
 * @param mcpServerUrl - Optional URL to override environment variables
 * @returns Promise resolving to result object with agent, mcpConnected flag, and optional error
 */
export async function createItalianAgentWithMCP(mcpServerUrl?: string): Promise<{ agent: RealtimeAgent, mcpConnected: boolean, error?: string }> {
  let mcpServer: MCPServerStreamableHttp | null = null;
  let errorMessage: string | undefined;
  
  // Try to initialize MCP server
  try {
    mcpServer = await initializeMCPServer(mcpServerUrl);
  } catch (error) {
    // MCP initialization failed - capture error but continue without MCP
    errorMessage = error instanceof Error 
      ? error.message 
      : "Unknown error occurred";
    
    // Format error message for user display
    if (errorMessage.includes('MCP server URL not configured')) {
      errorMessage = "MCP server URL not configured. Agent will work without MCP tools.";
    } else if (errorMessage.includes('Failed to connect to MCP server')) {
      errorMessage = `Could not connect to MCP server: ${errorMessage.replace('Failed to connect to MCP server at ', '')}. Agent will work without MCP tools.`;
    } else {
      errorMessage = `Could not connect to MCP server: ${errorMessage}. Agent will work without MCP tools.`;
    }
  }
  
  // Create agent with same instructions regardless of MCP status
  // Only difference is presence/absence of mcpServers property
  const agentConfig: any = {
    name: 'italianAgent',
    voice: 'sage',
    instructions: agentInstructionsWithMCP,
    handoffs: [],
    tools: [],
    handoffDescription: 'Agente conversazionale che parla solo italiano',
  };
  
  // Always add mcpServers if we have a server (wrapped in browser, direct on server)
  if (mcpServer) {
    agentConfig.mcpServers = [mcpServer];
  }
  
  const agent = new RealtimeAgent(agentConfig);
  
  // MCP is connected if we have a server instance (wrapped or direct)
  const actuallyConnected = mcpServer !== null;
  
  return {
    agent,
    mcpConnected: actuallyConnected,
    ...(errorMessage && { error: errorMessage }),
  };
}

/**
 * Returns the full scenario array with MCP-enabled agent (or without MCP if connection fails).
 * 
 * @param mcpServerUrl - Optional URL to override environment variables
 * @returns Promise resolving to result object with agents array, mcpConnected flag, and optional error
 */
export async function getItalianConversationScenarioWithMCP(mcpServerUrl?: string): Promise<{ agents: RealtimeAgent[], mcpConnected: boolean, error?: string }> {
  const result = await createItalianAgentWithMCP(mcpServerUrl);
  return {
    agents: [result.agent],
    mcpConnected: result.mcpConnected,
    ...(result.error && { error: result.error }),
  };
}

/**
 * Cleanup function to properly disconnect the MCP server.
 * Should be called when the session ends or the agent is no longer needed.
 */
export async function disconnectMCP(): Promise<void> {
  if (mcpServerInstance) {
    try {
      // TypeScript types may not include cleanup, but it exists in the runtime API
      // @ts-ignore - cleanup method exists at runtime but may not be in type definitions
      if (typeof mcpServerInstance.cleanup === 'function') {
        // @ts-ignore
        await mcpServerInstance.cleanup();
      }
    } catch (error) {
      console.error('Error disconnecting MCP server:', error);
    } finally {
      mcpServerInstance = null;
    }
  }
}

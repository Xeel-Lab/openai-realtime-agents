import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * MCP Server Proxy Route
 * 
 * Proxies MCP protocol requests from browser clients to the actual MCP server.
 * This allows browser clients to use MCP functionality by routing through
 * Next.js server-side code, avoiding browser shim limitations.
 * 
 * Supports:
 * - POST requests for JSON-RPC messages
 * - GET requests for SSE streams
 * - MCP protocol headers (MCP-Protocol-Version, Mcp-Session-Id, etc.)
 */

const MCP_LOG_FILE = path.join(process.cwd(), '.cursor', 'mcp-responses.log');
const MAX_LOG_BODY_SIZE = 10000; // Truncate bodies larger than 10KB

/**
 * Log MCP request/response to file (NDJSON format)
 */
async function logMCPInteraction(
  method: string,
  targetUrl: string,
  requestHeaders: Record<string, string>,
  requestBody: string | null,
  responseStatus: number,
  responseHeaders: Record<string, string>,
  responseBody: string | null,
  isSSE: boolean = false
): Promise<void> {
  try {
    const logEntry = {
      timestamp: new Date().toISOString(),
      method,
      targetUrl,
      request: {
        headers: requestHeaders,
        body: requestBody ? (requestBody.length > MAX_LOG_BODY_SIZE 
          ? requestBody.substring(0, MAX_LOG_BODY_SIZE) + '...[truncated]' 
          : requestBody) : null,
        bodySize: requestBody?.length || 0,
      },
      response: {
        status: responseStatus,
        headers: responseHeaders,
        body: responseBody ? (responseBody.length > MAX_LOG_BODY_SIZE 
          ? responseBody.substring(0, MAX_LOG_BODY_SIZE) + '...[truncated]' 
          : responseBody) : null,
        bodySize: responseBody?.length || 0,
        isSSE,
      },
    };

    const logLine = JSON.stringify(logEntry) + '\n';
    
    // Ensure .cursor directory exists
    const logDir = path.dirname(MCP_LOG_FILE);
    await fs.mkdir(logDir, { recursive: true });
    
    // Append to log file
    await fs.appendFile(MCP_LOG_FILE, logLine, 'utf-8');
  } catch (error) {
    // Don't fail the request if logging fails
    console.error('Failed to log MCP interaction:', error);
  }
}

/**
 * Get the base MCP server URL from environment variables
 */
function getMCPServerBaseUrl(): string {
  const mcpServerUrl = process.env.MCP_SERVER_URL;
  
  if (!mcpServerUrl) {
    throw new Error('MCP_SERVER_URL environment variable is not configured');
  }
  
  // Remove trailing slash if present
  return mcpServerUrl.replace(/\/$/, '');
}

/**
 * Forward MCP-specific headers from client request to MCP server
 */
function getForwardedHeaders(req: NextRequest): HeadersInit {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  
  // Forward MCP protocol version header
  const protocolVersion = req.headers.get('MCP-Protocol-Version');
  if (protocolVersion) {
    headers['MCP-Protocol-Version'] = protocolVersion;
  }
  
  // Forward MCP session ID header
  const sessionId = req.headers.get('Mcp-Session-Id');
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }
  
  // Forward Last-Event-ID for SSE resumption
  const lastEventId = req.headers.get('Last-Event-ID');
  if (lastEventId) {
    headers['Last-Event-ID'] = lastEventId;
  }
  
  // Forward Accept header if present (for SSE)
  const accept = req.headers.get('Accept');
  if (accept) {
    headers['Accept'] = accept;
  }
  
  return headers;
}

/**
 * Handle POST requests (JSON-RPC messages)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { path?: string[] } }
) {
  try {
    const baseUrl = getMCPServerBaseUrl();
    const pathSegments = params.path || [];
    const targetPath = pathSegments.length > 0 ? `/${pathSegments.join('/')}` : '';
    const targetUrl = `${baseUrl}${targetPath}`;
    
    // Get request body
    const body = await req.text();
    
    // Get headers to forward
    const headers = getForwardedHeaders(req);
    
    // Forward request to MCP server
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: body || undefined,
    });
    
    // Check if response is SSE stream
    const contentType = response.headers.get('Content-Type');
    const isSSE = contentType?.includes('text/event-stream');
    
    // Collect response headers for logging
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    if (isSSE) {
      // For SSE, we need to capture the stream content for logging
      let sseContent = '';
      const chunks: Uint8Array[] = [];
      
      // Stream SSE response back to client
      const stream = new ReadableStream({
        async start(controller) {
          const reader = response.body?.getReader();
          if (!reader) {
            controller.close();
            return;
          }
          
          try {
            const decoder = new TextDecoder();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
              // Store chunk for streaming
              chunks.push(value);
              controller.enqueue(value);
              
              // Collect content for logging (limit size)
              if (sseContent.length < MAX_LOG_BODY_SIZE) {
                sseContent += decoder.decode(value, { stream: true });
              }
            }
            controller.close();
            
            // Log after stream is complete
            await logMCPInteraction(
              'POST',
              targetUrl,
              headers as Record<string, string>,
              body || null,
              response.status,
              responseHeaders,
              sseContent || null,
              true
            );
          } catch (error) {
            console.error('Error streaming SSE response:', error);
            controller.error(error);
            
            // Log error
            await logMCPInteraction(
              'POST',
              targetUrl,
              headers as Record<string, string>,
              body || null,
              response.status,
              responseHeaders,
              `[Stream Error: ${error instanceof Error ? error.message : 'Unknown'}]`,
              true
            );
          }
        },
      });
      
      return new NextResponse(stream, {
        status: response.status,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          // Forward MCP session ID if present
          ...(response.headers.get('Mcp-Session-Id') && {
            'Mcp-Session-Id': response.headers.get('Mcp-Session-Id')!,
          }),
        },
      });
    } else {
      // Handle JSON response
      const responseText = await response.text();
      let responseData: any;
      
      try {
        responseData = JSON.parse(responseText);
      } catch {
        responseData = responseText;
      }
      
      // Log the interaction
      await logMCPInteraction(
        'POST',
        targetUrl,
        headers as Record<string, string>,
        body || null,
        response.status,
        responseHeaders,
        responseText,
        false
      );
      
      return new NextResponse(JSON.stringify(responseData), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          // Forward MCP session ID if present
          ...(response.headers.get('Mcp-Session-Id') && {
            'Mcp-Session-Id': response.headers.get('Mcp-Session-Id')!,
          }),
        },
      });
    }
  } catch (error) {
    console.error('Error proxying MCP POST request:', error);
    
    if (error instanceof Error && error.message.includes('MCP_SERVER_URL')) {
      return new NextResponse(
        JSON.stringify({ 
          error: 'MCP server not configured',
          message: error.message 
        }),
        { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    
    return new NextResponse(
      JSON.stringify({ 
        error: 'Failed to proxy request to MCP server',
        message: error instanceof Error ? error.message : 'Unknown error'
      }),
      { 
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

/**
 * Handle GET requests (SSE streams)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { path?: string[] } }
) {
  try {
    const baseUrl = getMCPServerBaseUrl();
    const pathSegments = params.path || [];
    const targetPath = pathSegments.length > 0 ? `/${pathSegments.join('/')}` : '';
    const targetUrl = `${baseUrl}${targetPath}`;
    
    // Get headers to forward
    const headers: HeadersInit = {
      'Accept': 'text/event-stream',
      ...getForwardedHeaders(req),
    };
    
    // Forward GET request to MCP server
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers,
    });
    
    // Collect response headers for logging
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    
    // Check if server supports SSE
    const contentType = response.headers.get('Content-Type');
    if (!contentType?.includes('text/event-stream')) {
      const errorText = response.status === 405 
        ? 'SSE not supported by MCP server' 
        : 'Expected SSE stream';
      
      // Log the error response
      await logMCPInteraction(
        'GET',
        targetUrl,
        headers as Record<string, string>,
        null,
        response.status,
        responseHeaders,
        errorText,
        false
      );
      
      if (response.status === 405) {
        return new NextResponse(errorText, { status: 405 });
      }
      return new NextResponse(errorText, { status: 500 });
    }
    
    // For SSE, capture content for logging
    let sseContent = '';
    
    // Stream SSE response back to client
    const stream = new ReadableStream({
      async start(controller) {
        const reader = response.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }
        
        try {
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            controller.enqueue(value);
            
            // Collect content for logging (limit size)
            if (sseContent.length < MAX_LOG_BODY_SIZE) {
              sseContent += decoder.decode(value, { stream: true });
            }
          }
          controller.close();
          
          // Log after stream is complete
          await logMCPInteraction(
            'GET',
            targetUrl,
            headers as Record<string, string>,
            null,
            response.status,
            responseHeaders,
            sseContent || null,
            true
          );
        } catch (error) {
          console.error('Error streaming SSE response:', error);
          controller.error(error);
          
          // Log error
          await logMCPInteraction(
            'GET',
            targetUrl,
            headers as Record<string, string>,
            null,
            response.status,
            responseHeaders,
            `[Stream Error: ${error instanceof Error ? error.message : 'Unknown'}]`,
            true
          );
        }
      },
    });
    
    return new NextResponse(stream, {
      status: response.status,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        // Forward MCP session ID if present
        ...(response.headers.get('Mcp-Session-Id') && {
          'Mcp-Session-Id': response.headers.get('Mcp-Session-Id')!,
        }),
      },
    });
  } catch (error) {
    console.error('Error proxying MCP GET request:', error);
    
    if (error instanceof Error && error.message.includes('MCP_SERVER_URL')) {
      return new NextResponse(
        JSON.stringify({ 
          error: 'MCP server not configured',
          message: error.message 
        }),
        { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
    
    return new NextResponse(
      JSON.stringify({ 
        error: 'Failed to proxy request to MCP server',
        message: error instanceof Error ? error.message : 'Unknown error'
      }),
      { 
        status: 502,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

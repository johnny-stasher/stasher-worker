// Cloudflare Worker environment
interface Env {
  STASHED_KV: KVNamespace;
  GITHUB_TOKEN?: string;
  CI?: string;
  WORKERS_CI?: string;
  WORKERS_CI_BUILD_UUID?: string;
  WORKERS_CI_COMMIT_SHA?: string;
  WORKERS_CI_BRANCH?: string;
}

// API request/response types
interface EnstashRequest {
  iv: string;
  tag: string;
  ciphertext: string;
}

interface EnstashResponse {
  id: string;
}

interface DestashResponse {
  iv: string;
  tag: string;
  ciphertext: string;
}

interface UnstashResponse {
  status: string;
  id: string;
}

interface ErrorResponse {
  error: string;
  requestId: string;
}

interface VerifyResponse {
  commit: string;
  deployedAt: string;
  buildUuid?: string;
  branch?: string;
  ci: boolean;
  workersCI: boolean;
}

const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Generate unique request ID for observability/debugging
      const requestId = crypto.randomUUID();
      console.log(`[${requestId}] ${request.method} ${path}`);

      // Shared response helper
      const json = (data: any, status: number = 200, extraHeaders: Record<string, string> = {}): Response =>
        new Response(JSON.stringify(data), {
          status,
          headers: { 'Content-Type': 'application/json', ...extraHeaders }
        });

      // UUID v4 validation regex (aligned with CLI)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      
      // Constants (aligned with CLI)
      const MAX_TTL = 10 * 60; // 10 minutes in seconds
      const MAX_PAYLOAD_SIZE = 10 * 1024; // 10KB encrypted JSON

      // POST /enstash - store encrypted payload
      if (path === '/enstash' && request.method === 'POST') {
        // Validate Content-Type
        if (!request.headers.get('content-type')?.includes('application/json')) {
          return json({ error: 'Expected Content-Type: application/json', requestId } as ErrorResponse, 415, { 'Cache-Control': 'no-store' });
        }

        // Check raw payload size first
        const raw = await request.text();
        if (raw.length > MAX_PAYLOAD_SIZE) {
          return json({ error: `Payload too large (max ${MAX_PAYLOAD_SIZE} bytes)`, requestId } as ErrorResponse, 413, { 'Cache-Control': 'no-store' });
        }

        let body: EnstashRequest;
        try {
          body = JSON.parse(raw) as EnstashRequest;
        } catch {
          return json({ error: 'Invalid JSON', requestId } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
              
        // Validate required fields
        if (!body.iv || !body.tag || !body.ciphertext) {
          return json({ error: 'Missing required fields: iv, tag, ciphertext', requestId } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }

        // Generate UUID
        const id = crypto.randomUUID();
        
        // Store in KV
        const dataToStore = {
          iv: body.iv,
          tag: body.tag,
          ciphertext: body.ciphertext
        };
        
        // Store with KV namespace prefix and fixed 10-minute TTL
        const key = `secret:${id}`;
        await env.STASHED_KV.put(key, JSON.stringify(dataToStore), { expirationTtl: MAX_TTL });

        return json({ id } as EnstashResponse, 201);
      }

      // GET /destash/<uuid> - retrieve encrypted payload
      if (path.startsWith('/destash/') && request.method === 'GET') {
        const segments = path.split('/').filter(Boolean);
        
        // Ensure proper path structure
        if (segments.length !== 2) {
          return json({ error: 'Malformed path', requestId } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
        
        const id = segments[1];
        
        // Validate UUID
        if (!id) {
          return json({ error: 'Missing uuid', requestId } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
        if (!uuidRegex.test(id)) {
          return json({ error: 'Invalid uuid format', requestId } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }

        const key = `secret:${id}`;
        const data = await env.STASHED_KV.get(key);
        
        if (!data) {
          return json({ error: 'Stash not found', requestId } as ErrorResponse, 404, { 'Cache-Control': 'no-store' });
        }

        const parsedData = JSON.parse(data) as DestashResponse;

        // Delete after retrieval (burn after reading)
        await env.STASHED_KV.delete(key);
        
        // Return crypto data
        const responseData: DestashResponse = {
          iv: parsedData.iv,
          tag: parsedData.tag,
          ciphertext: parsedData.ciphertext
        };

        return json(responseData, 200, { 'Cache-Control': 'no-store' });
      }

      // DELETE /unstash/<uuid> - manually delete a secret
      if (path.startsWith('/unstash/') && request.method === 'DELETE') {
        const segments = path.split('/').filter(Boolean);
        
        // Ensure proper path structure
        if (segments.length !== 2) {
          return json({ error: 'Malformed path', requestId } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
        
        const id = segments[1];
        
        // Validate UUID
        if (!id) {
          return json({ error: 'Missing uuid', requestId } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
        if (!uuidRegex.test(id)) {
          return json({ error: 'Invalid uuid format', requestId } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }

        // Check if key exists before deleting
        const key = `secret:${id}`;
        const data = await env.STASHED_KV.get(key);
        
        if (!data) {
          return json({ error: 'Stash not found', requestId } as ErrorResponse, 404, { 'Cache-Control': 'no-store' });
        }

        // Delete the secret
        await env.STASHED_KV.delete(key);

        return json({ status: 'deleted', id } as UnstashResponse);
      }

      // GET /verify - return deployment info
      if (path === '/verify') {
        console.log('ENV DUMP:', JSON.stringify(env, null, 2));
        return json({
          commit: env.WORKERS_CI_COMMIT_SHA || 'unknown',
          deployedAt: new Date().toISOString(),
          buildUuid: env.WORKERS_CI_BUILD_UUID,
          branch: env.WORKERS_CI_BRANCH,
          ci: env.CI === 'true',
          workersCI: env.WORKERS_CI === '1'
        });
      }

      // 404 for all other routes
      return json({ error: 'Not found', requestId } as ErrorResponse, 404, { 'Cache-Control': 'no-store' });

    } catch (error) {
      // requestId is scoped inside try block, so generate a fallback for catch
      const fallbackRequestId = crypto.randomUUID();
      console.error(`[${fallbackRequestId}] Worker Error: ${request.method} ${request.url}`, error);
      return new Response(
        JSON.stringify({ error: 'Internal server error', requestId: fallbackRequestId } as ErrorResponse),
        { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  }
};

export default worker;
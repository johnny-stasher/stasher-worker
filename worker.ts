// Cloudflare Worker environment
interface Env {
  STASHED_KV: KVNamespace;
  STASHER_DO: DurableObjectNamespace;
  GITHUB_TOKEN?: string;
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
}


const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for cross-origin requests from any domain
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    };

    // Handle preflight OPTIONS requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {

      // Shared response helper with CORS headers
      const json = (data: any, status: number = 200, extraHeaders: Record<string, string> = {}): Response =>
        new Response(JSON.stringify(data), {
          status,
          headers: { 
            'Content-Type': 'application/json', 
            ...corsHeaders,  // Include CORS headers in all responses
            ...extraHeaders 
          }
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
          return json({ error: 'Expected Content-Type: application/json' } as ErrorResponse, 415, { 'Cache-Control': 'no-store' });
        }

        // Check raw payload size first (using actual byte length)
        const raw = await request.text();
        const rawBytes = new TextEncoder().encode(raw);
        if (rawBytes.byteLength > MAX_PAYLOAD_SIZE) {
          return json({ error: `Payload too large (max ${MAX_PAYLOAD_SIZE} bytes)` } as ErrorResponse, 413, { 'Cache-Control': 'no-store' });
        }

        let body: EnstashRequest;
        try {
          body = JSON.parse(raw) as EnstashRequest;
        } catch {
          return json({ error: 'Invalid JSON' } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
              
        // Validate required fields
        if (!body.iv || !body.tag || !body.ciphertext) {
          return json({ error: 'Missing required fields: iv, tag, ciphertext' } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }

        // Base64 validation regex (RFC 4648) - enforces proper padding rules
        const base64Regex = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
        
        // Validate field types and formats
        if (typeof body.iv !== 'string' || typeof body.tag !== 'string' || typeof body.ciphertext !== 'string') {
          return json({ error: 'Fields must be strings' } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
        
        // Validate base64 format
        if (!base64Regex.test(body.iv) || !base64Regex.test(body.tag) || !base64Regex.test(body.ciphertext)) {
          return json({ error: 'Fields must be valid base64' } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
        
        // Validate field lengths using actual byte lengths (not UTF-16 code units)
        if (new TextEncoder().encode(body.iv).byteLength > 24) {
          return json({ error: 'IV too long (max 24 bytes)' } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
        if (new TextEncoder().encode(body.tag).byteLength > 24) {
          return json({ error: 'Tag too long (max 24 bytes)' } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
        if (new TextEncoder().encode(body.ciphertext).byteLength > 16384) {
          return json({ error: 'Ciphertext too long (max 16384 bytes)' } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }

        // Generate UUID
        const id = crypto.randomUUID();
        
        // Prepare data for storage
        const dataToStore = {
          iv: body.iv,
          tag: body.tag,
          ciphertext: body.ciphertext
        };
        
        // Step 1: Store in KV first (can be safely retried)
        const key = `secret:${id}`;
        try {
          await env.STASHED_KV.put(key, JSON.stringify(dataToStore), { expirationTtl: MAX_TTL });
        } catch (kvError) {
          return json({ error: 'Failed to store encrypted payload' } as ErrorResponse, 500, { 'Cache-Control': 'no-store' });
        }
        
        // Step 2: Create Durable Object record (with rollback on failure)
        const doId = env.STASHER_DO.idFromName(id);
        const doStub = env.STASHER_DO.get(doId);
        
        const timestamp = Math.floor(Date.now() / 1000);
        try {
          const doResponse = await doStub.fetch(new Request('https://stasher.internal/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timestamp })
          }));
          
          if (!doResponse.ok) {
            // Handle idempotency conflict (409) - DO already created, this is actually OK
            if (doResponse.status === 409) {
              // DO already exists, but we have KV data - this is a valid race condition resolution
              return json({ id } as EnstashResponse, 201);
            }
            
            // Other errors - rollback KV
            await env.STASHED_KV.delete(key);
            return json({ error: 'Failed to create stash record' } as ErrorResponse, 500, { 'Cache-Control': 'no-store' });
          }
        } catch (doError) {
          // Rollback: Delete KV entry since DO creation failed
          await env.STASHED_KV.delete(key);
          return json({ error: 'Failed to create stash record' } as ErrorResponse, 500, { 'Cache-Control': 'no-store' });
        }

        return json({ id } as EnstashResponse, 201);
      }

      // GET /destash/<uuid> - retrieve encrypted payload
      if (path.startsWith('/destash/') && request.method === 'GET') {
        // Extract UUID from path, handling trailing slashes gracefully
        const match = path.match(/^\/destash\/([^\/]+)\/?$/);
        if (!match) {
          return json({ error: 'Malformed path' } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
        
        const id = match[1];
        
        // Validate UUID
        if (!id) {
          return json({ error: 'Missing uuid' } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
        if (!uuidRegex.test(id)) {
          return json({ error: 'Invalid uuid format' } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }

        // Check Durable Object first - atomic consume operation
        const doId = env.STASHER_DO.idFromName(id);
        const doStub = env.STASHER_DO.get(doId);
        
        const doResponse = await doStub.fetch(new Request('https://stasher.internal/consume', {
          method: 'POST'
        }));
        
        if (!doResponse.ok) {
          // Preserve DO status codes: 410 for expired/consumed, 404 for never existed
          if (doResponse.status === 410) {
            const errorData = await doResponse.json() as { error?: string };
            const message = errorData.error === 'Expired' ? 'Stash expired' : 'Stash already consumed';
            return json({ error: message } as ErrorResponse, 410, { 'Cache-Control': 'no-store' });
          }
          return json({ error: 'Stash not found' } as ErrorResponse, 404, { 'Cache-Control': 'no-store' });
        }
        
        // DO gave permission, now get from KV
        const key = `secret:${id}`;
        const data = await env.STASHED_KV.get(key);
        
        if (!data) {
          return json({ error: 'Stash not found' } as ErrorResponse, 404, { 'Cache-Control': 'no-store' });
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
        // Extract UUID from path, handling trailing slashes gracefully
        const match = path.match(/^\/unstash\/([^\/]+)\/?$/);
        if (!match) {
          return json({ error: 'Malformed path' } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
        
        const id = match[1];
        
        // Validate UUID
        if (!id) {
          return json({ error: 'Missing uuid' } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }
        if (!uuidRegex.test(id)) {
          return json({ error: 'Invalid uuid format' } as ErrorResponse, 400, { 'Cache-Control': 'no-store' });
        }

        // Check Durable Object first - atomic delete operation
        const doId = env.STASHER_DO.idFromName(id);
        const doStub = env.STASHER_DO.get(doId);
        
        const doResponse = await doStub.fetch(new Request('https://stasher.internal/', {
          method: 'DELETE'
        }));
        
        if (!doResponse.ok) {
          // Preserve DO status codes: 410 for expired/consumed, 404 for never existed
          if (doResponse.status === 410) {
            const errorData = await doResponse.json() as { error?: string };
            const message = errorData.error === 'Expired' ? 'Stash expired' : 'Stash already consumed';
            return json({ error: message } as ErrorResponse, 410, { 'Cache-Control': 'no-store' });
          }
          return json({ error: 'Stash not found' } as ErrorResponse, 404, { 'Cache-Control': 'no-store' });
        }
        
        // DO confirmed deletion, now clean up KV
        const key = `secret:${id}`;
        await env.STASHED_KV.delete(key);

        return json({ status: 'deleted', id } as UnstashResponse);
      }


      // 404 for all other routes
      return json({ error: 'Not found' } as ErrorResponse, 404, { 'Cache-Control': 'no-store' });

    } catch (error) {
      return new Response(
        JSON.stringify({ error: 'Internal server error' } as ErrorResponse),
        { 
          status: 500,
          headers: { 
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        }
      );
    }
  }
};

// Durable Object for atomic stash operations
export class StasherDO {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Use blockConcurrencyWhile to prevent races with alarm() method
    return await this.state.blockConcurrencyWhile(async () => {
      // Skip expiry validation for CREATE requests since they don't have a timestamp yet
      if (!(request.method === 'POST' && url.pathname === '/create')) {
        // Phase 1: Reactive expiry validation - check at beginning of non-create requests
        const createdAt = await this.state.storage.get('created_at');
        
        // If no timestamp exists, stash has already been consumed/deleted
        if (!createdAt) {
          return new Response(JSON.stringify({ error: 'Gone' }), { status: 410 });
        }
        
        // Calculate expiry: created_at + 10 minutes (600,000 ms)
        // Note: createdAt is stored as seconds, so convert to ms for comparison
        const createdAtMs = (createdAt as number) * 1000;
        const expiryMs = createdAtMs + 600000; // 10 minutes in milliseconds
        const nowMs = Date.now();
        
        // If expired, delete all data and return 410 Gone
        if (nowMs >= expiryMs) {
          await this.state.storage.deleteAll();
          return new Response(JSON.stringify({ error: 'Expired' }), { status: 410 });
        }
      }
      
      if (request.method === 'POST' && url.pathname === '/create') {
        const body: { timestamp: number } = await request.json();
        
        // Validate timestamp is a sane number with reasonable skew tolerance
        const now = Math.floor(Date.now() / 1000);
        const maxSkew = 300; // 5 minutes in seconds
        if (!Number.isInteger(body.timestamp) || 
            body.timestamp < (now - maxSkew) || 
            body.timestamp > (now + maxSkew)) {
          return new Response(JSON.stringify({ error: 'Invalid timestamp' }), { status: 400 });
        }
        
        // Check if already created - prevent replay attacks that could reset alarm
        const existingTimestamp = await this.state.storage.get('created_at');
        if (existingTimestamp) {
          return new Response(JSON.stringify({ error: 'Already created' }), { status: 409 });
        }
        
        await this.state.storage.put('created_at', body.timestamp);
        
        // Phase 2: Proactive alarm - set alarm for 10 minutes after creation
        const timestampMs = body.timestamp * 1000; // Convert seconds to milliseconds
        const alarmTime = timestampMs + 600000; // Add 10 minutes (600,000 ms)
        await this.state.storage.setAlarm(new Date(alarmTime));
        
        return new Response(JSON.stringify({ status: 'created' }));
      }
      
      if (request.method === 'POST' && url.pathname === '/consume') {
        const createdAt = await this.state.storage.get('created_at');
        if (!createdAt) {
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }
        
        await this.state.storage.delete('created_at');
        return new Response(JSON.stringify({ status: 'consumed', created_at: createdAt }));
      }
      
      if (request.method === 'DELETE') {
        const createdAt = await this.state.storage.get('created_at');
        if (!createdAt) {
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }
        
        await this.state.storage.delete('created_at');
        return new Response(JSON.stringify({ status: 'deleted' }));
      }
      
      return new Response('Not found', { status: 404 });
    });
  }
  
  // Phase 2: Proactive alarm handler - called automatically by Cloudflare after 10 minutes
  async alarm(): Promise<void> {
    // Use blockConcurrencyWhile to prevent races with fetch() method
    await this.state.blockConcurrencyWhile(async () => {
      // Clean up the DO by deleting all stored data
      await this.state.storage.deleteAll();
    });
  }
}

export default worker;
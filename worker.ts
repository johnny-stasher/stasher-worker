// Cloudflare Worker environment
interface Env {
  STASHER_DO: DurableObjectNamespace;
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
    const path = url.pathname.replace(/\/+$/, '');

    // CORS headers for cross-origin requests from any domain
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };

    // Handle preflight OPTIONS requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {

      // Shared response helper with CORS headers and global no-cache policy
      const json = (data: any, status: number = 200, extraHeaders: Record<string, string> = {}): Response =>
        new Response(JSON.stringify(data), {
          status,
          headers: { 
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',  // Global no-cache policy for all JSON responses
            'Pragma': 'no-cache',         // Additional cache prevention for older proxies
            ...corsHeaders,               // Include CORS headers in all responses
            ...extraHeaders 
          }
        });

      // Base64 normalization: convert URL-safe to standard base64
      function normalizeBase64(s: string): string {
        return s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + (4 - s.length % 4) % 4, '=');
      }

      // Base64 decoder with proper error handling (accepts both standard and URL-safe)
      function b64ToBytes(s: string): Uint8Array | null {
        try {
          // Normalize URL-safe base64 to standard base64 before decoding
          const normalized = normalizeBase64(s);
          const bin = atob(normalized);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) {
            out[i] = bin.charCodeAt(i);
          }
          return out;
        } catch {
          return null;
        }
      }

      // UUID v4 validation regex (aligned with CLI)
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      
      // Constants (aligned with CLI)
      const MAX_PAYLOAD_SIZE = 10 * 1024; // 10KB encrypted JSON
      
      // AES-GCM crypto constants for proper validation
      const IV_BYTES = 12;  // 96-bit nonce for AES-GCM
      const TAG_BYTES = 16; // 128-bit authentication tag
      const MAX_CIPHERTEXT_BYTES = 16384; // Max ciphertext size in bytes

      // POST /enstash - store encrypted payload
      if (path === '/enstash' && request.method === 'POST') {
        // Validate Content-Type
        if (!request.headers.get('content-type')?.includes('application/json')) {
          return json({ error: 'Expected Content-Type: application/json' } as ErrorResponse, 415);
        }

        // Early size check via Content-Length header (before buffering)
        const contentLength = request.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_SIZE) {
          return json({ error: `Payload too large (max ${MAX_PAYLOAD_SIZE} bytes)` } as ErrorResponse, 413);
        }

        // Read and validate actual payload size (fallback for missing Content-Length)
        const raw = await request.text();
        const rawBytes = new TextEncoder().encode(raw);
        if (rawBytes.byteLength > MAX_PAYLOAD_SIZE) {
          return json({ error: `Payload too large (max ${MAX_PAYLOAD_SIZE} bytes)` } as ErrorResponse, 413);
        }

        let body: EnstashRequest;
        try {
          body = JSON.parse(raw) as EnstashRequest;
        } catch {
          return json({ error: 'Invalid JSON' } as ErrorResponse, 400);
        }
              
        // Validate required fields
        if (!body.iv || !body.tag || !body.ciphertext) {
          return json({ error: 'Missing required fields: iv, tag, ciphertext' } as ErrorResponse, 400);
        }

        // Validate field types
        if (typeof body.iv !== 'string' || typeof body.tag !== 'string' || typeof body.ciphertext !== 'string') {
          return json({ error: 'Fields must be strings' } as ErrorResponse, 400);
        }

        // Base64 validation regex - accepts both standard (+/) and URL-safe (-_) base64
        const base64Regex = /^[A-Za-z0-9+/\-_]*={0,2}$/;
        
        // Validate base64 format before decoding (accepts both standard and URL-safe)
        if (!base64Regex.test(body.iv) || !base64Regex.test(body.tag) || !base64Regex.test(body.ciphertext)) {
          return json({ error: 'Fields must be valid base64 (standard or URL-safe)' } as ErrorResponse, 400);
        }
        
        // Decode and validate actual crypto material lengths
        const ivBytes = b64ToBytes(body.iv);
        const tagBytes = b64ToBytes(body.tag);  
        const ctBytes = b64ToBytes(body.ciphertext);
        
        if (!ivBytes || !tagBytes || !ctBytes) {
          return json({ error: 'Invalid base64 encoding' } as ErrorResponse, 400);
        }
        
        // Validate decoded crypto material sizes for AES-GCM
        if (ivBytes.byteLength !== IV_BYTES) {
          return json({ error: `IV must be exactly ${IV_BYTES} bytes (96-bit nonce)` } as ErrorResponse, 400);
        }
        if (tagBytes.byteLength !== TAG_BYTES) {
          return json({ error: `Tag must be exactly ${TAG_BYTES} bytes (128-bit auth tag)` } as ErrorResponse, 400);
        }
        if (ctBytes.byteLength === 0) {
          return json({ error: 'Ciphertext cannot be empty' } as ErrorResponse, 400);
        }
        if (ctBytes.byteLength > MAX_CIPHERTEXT_BYTES) {
          return json({ error: `Ciphertext too large (max ${MAX_CIPHERTEXT_BYTES} bytes)` } as ErrorResponse, 400);
        }

        // Generate UUID
        const id = crypto.randomUUID();
        
        // Prepare data for storage
        const payloadData = {
          iv: body.iv,
          tag: body.tag,
          ciphertext: body.ciphertext
        };
        
        // Store everything atomically in Durable Object
        const doId = env.STASHER_DO.idFromName(id);
        const doStub = env.STASHER_DO.get(doId);
        
        const timestamp = Math.floor(Date.now() / 1000);
        try {
          const doResponse = await doStub.fetch(new Request('https://stasher.internal/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ timestamp, payload: payloadData })
          }));
          
          if (!doResponse.ok) {
            // Handle idempotency conflict (409) - DO already created, this is OK
            if (doResponse.status === 409) {
              return json({ id } as EnstashResponse, 201);
            }
            
            return json({ error: 'Failed to create stash record' } as ErrorResponse, 500);
          }
        } catch (doError) {
          return json({ error: 'Failed to create stash record' } as ErrorResponse, 500);
        }

        return json({ id } as EnstashResponse, 201);
      }

      // GET /destash/<uuid> - retrieve encrypted payload
      if (path.startsWith('/destash/') && request.method === 'GET') {
        const segments = path.split('/');
        if (segments.length !== 3 || segments[0] !== '' || segments[1] !== 'destash') {
          return json({ error: 'Malformed path' } as ErrorResponse, 400);
        }
        
        const id = segments[2].toLowerCase();
        
        // Validate UUID
        if (!id) {
          return json({ error: 'Missing uuid' } as ErrorResponse, 400);
        }
        if (!uuidRegex.test(id)) {
          return json({ error: 'Invalid uuid format' } as ErrorResponse, 400);
        }

        // Atomically consume payload from Durable Object
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
            return json({ error: message } as ErrorResponse, 410);
          }
          return json({ error: 'Stash not found' } as ErrorResponse, 404);
        }
        
        // Extract payload from DO response
        const responseData = await doResponse.json() as DestashResponse;

        return json(responseData, 200);
      }

      // DELETE /unstash/<uuid> - manually delete a secret
      if (path.startsWith('/unstash/') && request.method === 'DELETE') {
        const segments = path.split('/');
        if (segments.length !== 3 || segments[0] !== '' || segments[1] !== 'unstash') {
          return json({ error: 'Malformed path' } as ErrorResponse, 400);
        }
        
        const id = segments[2].toLowerCase();
        
        // Validate UUID
        if (!id) {
          return json({ error: 'Missing uuid' } as ErrorResponse, 400);
        }
        if (!uuidRegex.test(id)) {
          return json({ error: 'Invalid uuid format' } as ErrorResponse, 400);
        }

        // Atomically delete from Durable Object
        const doId = env.STASHER_DO.idFromName(id);
        const doStub = env.STASHER_DO.get(doId);
        
        const doResponse = await doStub.fetch(new Request('https://stasher.internal/delete', {
          method: 'POST'
        }));
        
        if (!doResponse.ok) {
          // Preserve DO status codes: 410 for expired/consumed, 404 for never existed
          if (doResponse.status === 410) {
            const errorData = await doResponse.json() as { error?: string };
            const message = errorData.error === 'Expired' ? 'Stash expired' : 'Stash already consumed';
            return json({ error: message } as ErrorResponse, 410);
          }
          return json({ error: 'Stash not found' } as ErrorResponse, 404);
        }

        return json({ status: 'deleted', id } as UnstashResponse, 200);
      }


      // 404 for all other routes
      return json({ error: 'Not found' } as ErrorResponse, 404);

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
        const body: { timestamp: number; payload: any } = await request.json();
        
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
        
        // Store both timestamp and payload atomically
        await this.state.storage.put('created_at', body.timestamp);
        await this.state.storage.put('payload', body.payload);
        
        // Phase 2: Proactive alarm - set alarm for 10 minutes after creation
        const timestampMs = body.timestamp * 1000; // Convert seconds to milliseconds
        const alarmTime = timestampMs + 600000; // Add 10 minutes (600,000 ms)
        await this.state.storage.setAlarm(new Date(alarmTime));
        
        return new Response(JSON.stringify({ status: 'created' }));
      }
      
      if (request.method === 'POST' && url.pathname === '/consume') {
        const createdAt = await this.state.storage.get('created_at');
        const payload = await this.state.storage.get('payload');
        
        if (!createdAt || !payload) {
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }
        
        // Atomically delete both timestamp and payload (burn after reading)
        await this.state.storage.delete('created_at');
        await this.state.storage.delete('payload');
        
        // Return the payload directly
        return new Response(JSON.stringify(payload));
      }
      
      if (request.method === 'POST' && url.pathname === '/delete') {
        const createdAt = await this.state.storage.get('created_at');
        if (!createdAt) {
          return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        }
        
        // Delete both timestamp and payload
        await this.state.storage.delete('created_at');
        await this.state.storage.delete('payload');
        
        return new Response(JSON.stringify({ status: 'deleted' }));
      }
      
      return new Response(JSON.stringify({ error: 'Not found' }), { 
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
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
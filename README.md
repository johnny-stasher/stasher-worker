# Stasher API

Cloudflare Worker backend for 

[Stasher CLI](https://github.com/stasher-dev/stasher-cli) and 
[Stasher App](https://github.com/stasher-dev/stasher-app).  

Implements secure, one-time secret sharing with no trusted backend.

## Architecture

| Layer            | Technology                           |
|------------------|--------------------------------------|
| Runtime          | Cloudflare Workers (V8 isolates)     |
| Storage          | KV (encrypted payloads only)         |
| Coordination     | Durable Objects (per-secret isolation) |
| Expiry           | Reactive validation + scheduled cleanup |
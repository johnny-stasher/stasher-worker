# Stasher API

Cloudflare Worker API backend for the [Stasher CLI](https://github.com/stasher-dev/stasher-cli) - secure secret sharing with burn-after-read.

## Features

- **Zero-knowledge storage** - Only encrypted ciphertext stored
- **Guaranteed burn-after-read** - Race condition protection via Durable Objects
- **10-minute TTL** - All stashes expire automatically
- **Edge deployment** - Global Cloudflare network
- **Atomic operations** - Prevents double-retrieval under concurrent access

## Architecture

### Race Condition Challenge

The original implementation had a potential race condition with KV's eventual consistency:

1. Two concurrent GET `/destash/{id}` requests
2. Both read the same secret from KV successfully  
3. Both delete the key and return the secret
4. **Result**: Secret retrieved twice, violating burn-after-read guarantee

### Solution: Durable Objects for Atomic Control

The system now uses a hybrid architecture combining **KV for storage** and **Durable Objects for access control**:

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   POST /enstash │───▶│  Durable Object  │───▶│   KV Storage    │
│                 │    │  (Create token)  │    │ (Encrypted data)│
└─────────────────┘    └──────────────────┘    └─────────────────┘

┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   GET /destash  │───▶│  Durable Object  │───▶│   KV Storage    │
│                 │    │ (Atomic consume) │    │ (Fetch & delete)│
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

**Flow:**
1. **POST /enstash**: Creates both DO token (unix timestamp) and KV entry (encrypted data)
2. **GET /destash**: DO atomic consume → if successful, fetch from KV → delete from KV
3. **DELETE /unstash**: DO atomic delete → cleanup KV entry

**Benefits:**
- **Race condition eliminated** - DO provides strong consistency per secret ID
- **Guaranteed single retrieval** - Only first request gets DO permission
- **Minimal overhead** - DO stores only uuid & UNIX timestamps, KV handles encrypted payloads and ttl
- **Maintains performance** - Leverages both KV global distribution and DO consistency

## Project Structure

```
stasher-api/
├── worker.ts         # Main worker with hybrid KV+DO architecture
├── wrangler.toml     # Cloudflare Worker + Durable Objects config
├── package.json      # Project metadata
├── test.js           # Comprehensive test suite for all scenarios
├── README.md         # Documentation
└── LICENSE           # MIT License
```
## Related Projects

- **[Stasher CLI](https://github.com/stasher-dev/stasher-cli)** - Terminal version (`npm install -g stasher-cli` or `npx`)
- **[Stasher App](https://github.com/stasher-dev/stasher-app)** - Browser/web interface with bookmarklet support

## License

MIT

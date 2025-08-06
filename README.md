# Stasher API

Cloudflare Worker API backend for the [Stasher CLI](https://github.com/stasher-dev/stasher-cli) - secure secret sharing with burn-after-read.

## Features

- **Zero-knowledge storage** - Only encrypted ciphertext stored
- **Guaranteed burn-after-read** - Race condition protection via Durable Objects
- **Hybrid expiry system** - Reactive validation + proactive cleanup
- **10-minute TTL** - All stashes expire automatically with mathematical guarantees
- **Edge deployment** - Global Cloudflare network with atomic consistency
- **Self-destructing gatekeepers** - Durable Objects provide expiry enforcement

## Architecture

### Design Philosophy: Defense-in-Depth Security

Stasher's architecture is built on **zero-trust principles** with multiple layers of protection. Rather than relying on any single mechanism, the system implements **mathematical guarantees** through layered security controls.

### Challenge 1: Race Condition Protection

The original implementation had a potential race condition with KV's eventual consistency:

1. Two concurrent GET `/destash/{id}` requests
2. Both read the same secret from KV successfully  
3. Both delete the key and return the secret
4. **Result**: Secret retrieved twice, violating burn-after-read guarantee

### Challenge 2: Expiry Enforcement

Traditional approaches rely on external TTL mechanisms:
- KV expires after 10 minutes 
- But what if the expiry fails?
- What about clock drift between regions?
- Can we guarantee expired secrets are never accessible?

### Solution: Hybrid Two-Tier Architecture

The system uses **Durable Objects as self-destructing gatekeepers** combined with **KV for encrypted storage**:

```
┌─────────────────┐    ┌──────────────────────────┐    ┌─────────────────┐
│   POST /enstash │───▶│    Durable Object        │───▶│   KV Storage    │
│                 │    │ • Store timestamp        │    │ (Encrypted data)│
│                 │    │ • Set 10-min alarm       │    │  + 10-min TTL   │
└─────────────────┘    └──────────────────────────┘    └─────────────────┘

┌─────────────────┐    ┌──────────────────────────┐    ┌─────────────────┐
│   GET /destash  │───▶│    Durable Object        │───▶│   KV Storage    │
│                 │    │ • Check expiry first     │    │ (Fetch & delete)│
│                 │    │ • Atomic consume         │    │                 │
└─────────────────┘    └──────────────────────────┘    └─────────────────┘

                       ┌──────────────────────────┐
                       │     After 10 minutes     │
                       │ • Alarm triggers         │
                       │ • Self-destruct DO       │
                       │ • Cleanup unused stashes │
                       └──────────────────────────┘
```

### Dual-Layer Expiry System

**🔄 Reactive Expiry (Phase 1)**
- Every DO operation validates expiry **before** any logic
- `if (now > created_at + 600_000) { await storage.deleteAll(); return 410 }`
- Immediate cleanup of expired stashes on access
- Defense against clock drift or TTL failures

**⏰ Proactive Expiry (Phase 2)**  
- Cloudflare alarms automatically trigger after 10 minutes
- `await storage.setAlarm(new Date(created_at + 600_000))`
- Cleanup unused stashes even if never accessed again
- Resource efficiency and zombie prevention

### Why This Architecture?

**Mathematical Guarantees**
- **One UUID = One Durable Object** - Perfect isolation per secret
- **Atomic operations** - Race conditions mathematically impossible
- **Dual expiry validation** - Expired secrets can never be retrieved
- **Self-destruction** - Objects clean themselves up automatically

**Zero-Trust Design**
- Never trust external TTL mechanisms alone
- Every operation validates expiry independently  
- Multiple cleanup mechanisms (reactive + proactive + post-consume)
- Defense-in-depth through layered controls

**⚡ Performance Benefits**
- **DO overhead minimal** - Only stores timestamp metadata
- **KV handles heavy lifting** - Encrypted payloads + global distribution
- **Proactive cleanup** - Prevents resource accumulation
- **Edge consistency** - Strong guarantees where needed, eventual elsewhere

## Project Structure

```
stasher-api/
├── worker.ts         # Main worker with hybrid KV+DO architecture
├── wrangler.toml     # Cloudflare Worker + Durable Objects config
├── package.json      # Project metadata
├── test.js           # Comprehensive test suite for all scenarios
├── README.md         # Documentation
└── LICENSE           # BUSL-1.1 License
```

## Deployment

**Automated CI/CD Pipeline**

This API features automated deployment via [stasher-ci](https://github.com/stasher-dev/stasher-ci):

- **Automatic Deployment**: Pushes to `main` branch automatically deploy to Cloudflare Workers
- **Edge Network**: Deployed globally via Cloudflare's edge infrastructure
- **Build Pipeline**: TypeScript checking, linting, and worker optimization  
- **Zero Downtime**: Atomic deployments with instant global propagation
- **Infrastructure**: KV storage + Durable Objects for hybrid consistency model

**Deployment Status**: [![CI/CD Pipeline](https://github.com/stasher-dev/stasher-api/actions/workflows/ci.yml/badge.svg)](https://github.com/stasher-dev/stasher-api/actions/workflows/ci.yml)

## Cryptographic Verification

**All releases are signed with Cosign** using GitHub OIDC keyless signing and logged to the [Rekor transparency log](https://rekor.sigstore.dev).

### Verify Worker Bundle

The Cloudflare Worker bundle is signed during the release process:

```bash
# Install cosign (if you don't have it)
# macOS: brew install cosign
# Linux: see https://docs.sigstore.dev/cosign/installation/

# Get the latest release version
VERSION=$(gh release list -R stasher-dev/stasher-api --limit 1 | cut -f1)

# Download checksums and signature
curl -L -O "https://github.com/stasher-dev/stasher-api/releases/download/$VERSION/checksums.txt"
curl -L -O "https://github.com/stasher-dev/stasher-api/releases/download/$VERSION/checksums.txt.sig"

# Verify signature
cosign verify-blob \
  --certificate-identity-regexp="https://github.com/stasher-dev/stasher-api/.*" \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  --signature=checksums.txt.sig \
  checksums.txt

# Verify integrity
sha256sum -c checksums.txt
```

### Runtime Verification

Since this is deployed as a Cloudflare Worker, you can verify the deployed API matches the signed source:

```bash
# Compare deployed API metadata
curl -s https://stasher-api.johnny.workers.dev/ | jq -r '.version // "version not exposed"'

# Cross-reference with GitHub releases
gh release list -R stasher-dev/stasher-api
```

### What This Proves

**Source Integrity** - Worker code matches signed GitHub releases  
**Build Authenticity** - Code was built by verified GitHub Actions  
**Supply Chain Security** - All dependencies and build steps are transparent  
**Deployment Traceability** - Direct path from source to production

**Your secrets deserve verified infrastructure.** 🛡️

## Related Projects

- **[Stasher CLI](https://github.com/stasher-dev/stasher-cli)** - Terminal version (`npm install -g stasher-cli` or `npx`)
- **[Stasher App](https://github.com/stasher-dev/stasher-app)** - Browser/web interface with bookmarklet support

## License

BUSL-1.1 - Business Source License with automatic conversion to Apache 2.0 on 2028-08-01

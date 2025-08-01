# Stasher Worker

Cloudflare Worker API backend for the [Stasher CLI](https://github.com/johnny-stasher/stasher) - secure secret sharing with burn-after-read.

## Features

- **Zero-knowledge storage** - Only encrypted ciphertext stored
- **Burn-after-read** - Stash deleted after first retrieval  
- **10-minute TTL** - All stashes expire automatically
- **Edge deployment** - Global Cloudflare network

## Project Structure

```
stasher-worker/
├── worker.ts         # Main worker entry point (TypeScript)
├── wrangler.toml     # Cloudflare Worker configuration  
├── package.json      # Project metadata
├── README.md         # Documentation
└── LICENSE           # MIT License
```

## License

MIT

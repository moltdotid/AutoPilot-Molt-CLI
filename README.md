# molt.id AutoPilot CLI

Client-side auto-signer for molt.id AI agent wallet transactions. Runs locally — polls the Multiclaw tx-queue API, builds transactions, signs with the NFT owner's keypair, and submits to Solana.

No browser required. Same functionality as the AutoPilot page in the web UI.

## Setup

```bash
npm install
```

## Usage

```bash
node autopilot.mjs --key <private-key> --asset <core-nft-pubkey> --user <userId>
```

### Arguments

| Flag | Description |
|------|-------------|
| `--key`, `-k` | Private key — base58 string, JSON array string, or path to a keypair JSON file |
| `--asset`, `-a` | Core NFT asset pubkey (base58) — your molt.id domain NFT |
| `--user`, `-u` | Multiclaw user ID (e.g. `molt_XXXXX`) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_ENDPOINT` | `https://api.mainnet-beta.solana.com` | Solana RPC URL |
| `OPENCLAW_URL` | `https://multiclaw.moltid.workers.dev` | Multiclaw worker URL |
| `POLL_INTERVAL_MS` | `5000` | Polling interval in milliseconds |

### Examples

```bash
# With base58 private key
node autopilot.mjs -k 5KbW...abc -a 8aMb3hW...Qyam -u molt_de65f0b21dec039107ff818c

# With keypair JSON file
node autopilot.mjs -k ~/my-keypair.json -a 8aMb3hW...Qyam -u molt_de65f0b21dec039107ff818c

# With custom RPC
RPC_ENDPOINT=https://rpc.solanatracker.io/public node autopilot.mjs -k key.json -a 8aMb...Qyam -u molt_XXXXX
```

## How It Works

1. You start the CLI with your NFT owner's private key
2. Your AI agent (OpenClaw) posts transaction requests to the tx-queue API
3. AutoPilot polls every 5s for pending operations
4. When found, it builds the transaction, signs it locally, and submits to Solana
5. Reports the result back to the queue so the AI knows the outcome

## Supported Operations

- **SOL**: Fund wallet, transfer SOL
- **Tokens**: Transfer, create, mint, burn SPL tokens
- **NFTs**: Mint, transfer, burn Core NFTs
- **Collections**: Create collection, mint NFT to collection
- **Cleanup**: Close empty token accounts

## Security

- Private key never leaves your machine — all signing is local
- Key is held in process memory only, never written to disk or sent anywhere
- The AI agent can only *request* transactions — it cannot execute without your key

#!/usr/bin/env node
/**
 * molt.id AutoPilot CLI
 *
 * Client-side auto-signer for AI agent wallet transactions.
 * Polls the Multiclaw tx-queue API, builds transactions, signs with
 * the NFT owner's keypair, and submits to Solana — no browser needed.
 *
 * Usage:
 *   node autopilot.mjs --key <base58-or-json-file> --asset <core-nft-pubkey> --user <userId>
 *
 * Environment variables (optional):
 *   RPC_ENDPOINT     — Solana RPC URL (default: https://api.mainnet-beta.solana.com)
 *   OPENCLAW_URL     — Multiclaw worker URL (default: https://multiclaw.moltid.workers.dev)
 *   POLL_INTERVAL_MS — Polling interval in ms (default: 5000)
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  createTransferInstruction as createSplTransferInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddress,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { readFileSync } from "fs";

// ─── Constants ───────────────────────────────────────────────────────

const MPL_CORE_PROGRAM_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
const OPENCLAW_URL = process.env.OPENCLAW_URL || "https://multiclaw.moltid.workers.dev";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);

// ─── CLI Argument Parsing ────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { key: "", asset: "", user: "" };

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--key" || args[i] === "-k") && args[i + 1]) opts.key = args[++i];
    else if ((args[i] === "--asset" || args[i] === "-a") && args[i + 1]) opts.asset = args[++i];
    else if ((args[i] === "--user" || args[i] === "-u") && args[i + 1]) opts.user = args[++i];
    else if (args[i] === "--help" || args[i] === "-h") {
      console.log(`
  molt.id AutoPilot CLI — auto-sign AI agent wallet transactions

  Usage:
    node autopilot.mjs --key <key> --asset <pubkey> --user <userId>

  Options:
    --key,   -k   Private key (base58 string, JSON array string, or path to JSON file)
    --asset, -a   Core NFT asset pubkey (base58)
    --user,  -u   Multiclaw user ID (e.g. molt_XXXXX)
    --help,  -h   Show this help

  Environment:
    RPC_ENDPOINT      Solana RPC URL
    OPENCLAW_URL      Multiclaw worker URL
    POLL_INTERVAL_MS  Poll interval in ms (default: 5000)
`);
      process.exit(0);
    }
  }

  if (!opts.key || !opts.asset || !opts.user) {
    console.error("Error: --key, --asset, and --user are all required. Use --help for usage.");
    process.exit(1);
  }
  return opts;
}

function loadKeypair(keyInput) {
  // Try as file path first
  try {
    const data = readFileSync(keyInput, "utf-8");
    const arr = JSON.parse(data);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch { /* not a file */ }

  // Try as JSON array string
  try {
    const arr = JSON.parse(keyInput);
    if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch { /* not JSON */ }

  // Try as base58
  try {
    const decoded = bs58.decode(keyInput);
    if (decoded.length === 64) return Keypair.fromSecretKey(decoded);
  } catch { /* not base58 */ }

  console.error("Error: Could not parse private key. Provide base58, JSON array, or path to keypair JSON file.");
  process.exit(1);
}

// ─── PDA & Wallet Helpers ────────────────────────────────────────────

function getAssetSignerPda(assetPubkey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mpl-core-execute"), assetPubkey.toBuffer()],
    MPL_CORE_PROGRAM_ID
  );
  return pda;
}

async function getAgentWalletInfo(connection, assetPubkey) {
  const walletPubkey = getAssetSignerPda(assetPubkey);
  const lamports = await connection.getBalance(walletPubkey);
  return {
    assetPubkey,
    walletPubkey,
    solBalance: lamports / LAMPORTS_PER_SOL,
    lamports: BigInt(lamports),
  };
}

async function getAgentTokenBalances(connection, assetPubkey) {
  const walletPubkey = getAssetSignerPda(assetPubkey);
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      programId: TOKEN_PROGRAM_ID,
    });
    return tokenAccounts.value.map((account) => {
      const parsed = account.account.data.parsed.info;
      return {
        mint: new PublicKey(parsed.mint),
        amount: BigInt(parsed.tokenAmount.amount),
        decimals: parsed.tokenAmount.decimals,
        uiAmount: parsed.tokenAmount.uiAmount || 0,
      };
    });
  } catch {
    return [];
  }
}

// ─── Transaction Builders ────────────────────────────────────────────

function buildExecuteV1Instruction(asset, collection, payer, authority, cpiInstruction) {
  const discriminator = 31;
  const ixData = cpiInstruction.data;
  const data = Buffer.alloc(1 + 4 + ixData.length);
  data.writeUInt8(discriminator, 0);
  data.writeUInt32LE(ixData.length, 1);
  Buffer.from(ixData).copy(data, 5);

  const assetSignerPda = getAssetSignerPda(asset);

  const keys = [
    { pubkey: asset, isSigner: false, isWritable: true },
    { pubkey: collection || asset, isSigner: false, isWritable: true },
    { pubkey: assetSignerPda, isSigner: false, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: authority, isSigner: true, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: cpiInstruction.programId, isSigner: false, isWritable: false },
  ];

  for (const key of cpiInstruction.keys) {
    keys.push({
      pubkey: key.pubkey,
      isSigner: key.pubkey.equals(assetSignerPda) ? false : key.isSigner,
      isWritable: key.isWritable,
    });
  }

  return new TransactionInstruction({ programId: MPL_CORE_PROGRAM_ID, keys, data });
}

function buildCreateMetadataV3Instruction(mint, mintAuthority, payer, updateAuthority, name, symbol, uri) {
  const [metadataPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA_PROGRAM_ID
  );
  const nameBytes = Buffer.from(name, "utf-8");
  const symbolBytes = Buffer.from(symbol, "utf-8");
  const uriBytes = Buffer.from(uri, "utf-8");
  const dataLen = 1 + (4 + nameBytes.length) + (4 + symbolBytes.length) + (4 + uriBytes.length) + 2 + 1 + 1 + 1 + 1 + 1;
  const data = Buffer.alloc(dataLen);
  let pos = 0;
  data.writeUInt8(33, pos); pos += 1;
  data.writeUInt32LE(nameBytes.length, pos); pos += 4; nameBytes.copy(data, pos); pos += nameBytes.length;
  data.writeUInt32LE(symbolBytes.length, pos); pos += 4; symbolBytes.copy(data, pos); pos += symbolBytes.length;
  data.writeUInt32LE(uriBytes.length, pos); pos += 4; uriBytes.copy(data, pos); pos += uriBytes.length;
  data.writeUInt16LE(0, pos); pos += 2;
  data.writeUInt8(0, pos); pos += 1;
  data.writeUInt8(0, pos); pos += 1;
  data.writeUInt8(0, pos); pos += 1;
  data.writeUInt8(1, pos); pos += 1;
  data.writeUInt8(0, pos);

  return new TransactionInstruction({
    programId: TOKEN_METADATA_PROGRAM_ID,
    keys: [
      { pubkey: metadataPda, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: mintAuthority, isSigner: true, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: updateAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function buildFundAgentWalletTx(connection, assetPubkey, fromPubkey, amountSol) {
  const agentWallet = getAssetSignerPda(assetPubkey);
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey, toPubkey: agentWallet, lamports: Math.floor(amountSol * LAMPORTS_PER_SOL) })
  );
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromPubkey;
  return tx;
}

async function buildAgentTransferSolTx(connection, assetPubkey, ownerPubkey, recipient, amountSol) {
  const agentWallet = getAssetSignerPda(assetPubkey);
  const transferIx = SystemProgram.transfer({
    fromPubkey: agentWallet, toPubkey: recipient, lamports: Math.floor(amountSol * LAMPORTS_PER_SOL),
  });
  const tx = new Transaction().add(buildExecuteV1Instruction(assetPubkey, null, ownerPubkey, ownerPubkey, transferIx));
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = ownerPubkey;
  return tx;
}

async function buildAgentTransferTokenTx(connection, assetPubkey, ownerPubkey, mintPubkey, recipient, amount) {
  const agentWallet = getAssetSignerPda(assetPubkey);
  const sourceAta = await getAssociatedTokenAddress(mintPubkey, agentWallet, true);
  const destAta = await getAssociatedTokenAddress(mintPubkey, recipient, true);
  const tx = new Transaction();
  const destInfo = await connection.getAccountInfo(destAta);
  if (!destInfo) tx.add(createAssociatedTokenAccountInstruction(ownerPubkey, destAta, recipient, mintPubkey));
  const transferIx = createSplTransferInstruction(sourceAta, destAta, agentWallet, amount);
  tx.add(buildExecuteV1Instruction(assetPubkey, null, ownerPubkey, ownerPubkey, transferIx));
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = ownerPubkey;
  return tx;
}

async function buildAgentCreateTokenTx(connection, assetPubkey, ownerPubkey, decimals, tokenName, tokenSymbol, tokenUri) {
  const agentWallet = getAssetSignerPda(assetPubkey);
  const mintKeypair = Keypair.generate();
  const mintPubkey = mintKeypair.publicKey;
  const lamports = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const tx = new Transaction();
  tx.add(SystemProgram.createAccount({ fromPubkey: ownerPubkey, newAccountPubkey: mintPubkey, space: MINT_SIZE, lamports, programId: TOKEN_PROGRAM_ID }));
  tx.add(createInitializeMintInstruction(mintPubkey, decimals, agentWallet, agentWallet));
  const agentAta = await getAssociatedTokenAddress(mintPubkey, agentWallet, true);
  tx.add(createAssociatedTokenAccountInstruction(ownerPubkey, agentAta, agentWallet, mintPubkey));
  if (tokenName) {
    const metaIx = buildCreateMetadataV3Instruction(mintPubkey, agentWallet, ownerPubkey, agentWallet, tokenName, tokenSymbol || "", tokenUri || "");
    tx.add(buildExecuteV1Instruction(assetPubkey, null, ownerPubkey, ownerPubkey, metaIx));
  }
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = ownerPubkey;
  return { tx, mintKeypair };
}

async function buildAgentMintTokensTx(connection, assetPubkey, ownerPubkey, mintPubkey, destination, amount) {
  const agentWallet = getAssetSignerPda(assetPubkey);
  const destAta = await getAssociatedTokenAddress(mintPubkey, destination, true);
  const tx = new Transaction();
  const destInfo = await connection.getAccountInfo(destAta);
  if (!destInfo) tx.add(createAssociatedTokenAccountInstruction(ownerPubkey, destAta, destination, mintPubkey));
  const mintToIx = createMintToInstruction(mintPubkey, destAta, agentWallet, amount);
  tx.add(buildExecuteV1Instruction(assetPubkey, null, ownerPubkey, ownerPubkey, mintToIx));
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = ownerPubkey;
  return tx;
}

async function buildAgentBurnTokensTx(connection, assetPubkey, ownerPubkey, mintPubkey, amount) {
  const agentWallet = getAssetSignerPda(assetPubkey);
  const agentAta = await getAssociatedTokenAddress(mintPubkey, agentWallet, true);
  const burnIx = createBurnInstruction(agentAta, mintPubkey, agentWallet, amount);
  const tx = new Transaction().add(buildExecuteV1Instruction(assetPubkey, null, ownerPubkey, ownerPubkey, burnIx));
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = ownerPubkey;
  return tx;
}

async function buildAgentCloseTokenAccountTx(connection, assetPubkey, ownerPubkey, tokenAccountPubkey) {
  const agentWallet = getAssetSignerPda(assetPubkey);
  const closeIx = createCloseAccountInstruction(tokenAccountPubkey, agentWallet, agentWallet);
  const tx = new Transaction().add(buildExecuteV1Instruction(assetPubkey, null, ownerPubkey, ownerPubkey, closeIx));
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = ownerPubkey;
  return tx;
}

async function getAgentCloseableTokenAccounts(connection, assetPubkey) {
  const agentWallet = getAssetSignerPda(assetPubkey);
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(agentWallet, { programId: TOKEN_PROGRAM_ID });
    return accounts.value
      .filter((a) => a.account.data.parsed.info.tokenAmount.amount === "0")
      .map((a) => ({ pubkey: a.pubkey, mint: new PublicKey(a.account.data.parsed.info.mint) }));
  } catch { return []; }
}

async function buildAgentMintNftTx(connection, assetPubkey, ownerPubkey, nftName, nftUri) {
  const agentWallet = getAssetSignerPda(assetPubkey);
  const mintKeypair = Keypair.generate();
  const nameBytes = Buffer.from(nftName, "utf-8");
  const uriBytes = Buffer.from(nftUri, "utf-8");
  const dataLen = 1 + 1 + 4 + nameBytes.length + 4 + uriBytes.length + 1;
  const data = Buffer.alloc(dataLen);
  let pos = 0;
  data.writeUInt8(0, pos); pos += 1;
  data.writeUInt8(0, pos); pos += 1;
  data.writeUInt32LE(nameBytes.length, pos); pos += 4; nameBytes.copy(data, pos); pos += nameBytes.length;
  data.writeUInt32LE(uriBytes.length, pos); pos += 4; uriBytes.copy(data, pos); pos += uriBytes.length;
  data.writeUInt8(0, pos);
  const ix = new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: mintKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: ownerPubkey, isSigner: true, isWritable: true },
      { pubkey: ownerPubkey, isSigner: true, isWritable: false },
      { pubkey: agentWallet, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = ownerPubkey;
  return { tx, mintKeypair };
}

async function buildAgentTransferNftTx(connection, domainAsset, ownerPubkey, nftAsset, recipient) {
  const agentWallet = getAssetSignerPda(domainAsset);
  const data = Buffer.from([14, 0]);
  const transferIx = new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: nftAsset, isSigner: false, isWritable: true },
      { pubkey: nftAsset, isSigner: false, isWritable: true },
      { pubkey: ownerPubkey, isSigner: true, isWritable: true },
      { pubkey: agentWallet, isSigner: true, isWritable: false },
      { pubkey: recipient, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(buildExecuteV1Instruction(domainAsset, domainAsset, ownerPubkey, ownerPubkey, transferIx));
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = ownerPubkey;
  return tx;
}

async function buildAgentBurnNftTx(connection, domainAsset, ownerPubkey, nftAsset) {
  const agentWallet = getAssetSignerPda(domainAsset);
  const data = Buffer.from([12, 0]);
  const burnIx = new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: nftAsset, isSigner: false, isWritable: true },
      { pubkey: ownerPubkey, isSigner: true, isWritable: true },
      { pubkey: agentWallet, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(buildExecuteV1Instruction(domainAsset, domainAsset, ownerPubkey, ownerPubkey, burnIx));
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = ownerPubkey;
  return tx;
}

async function buildCreateCollectionTx(connection, assetPubkey, ownerPubkey, collectionName, collectionUri) {
  const agentWallet = getAssetSignerPda(assetPubkey);
  const collectionKeypair = Keypair.generate();
  const nameBytes = Buffer.from(collectionName, "utf-8");
  const uriBytes = Buffer.from(collectionUri, "utf-8");
  const dataLen = 1 + 4 + nameBytes.length + 4 + uriBytes.length + 1;
  const data = Buffer.alloc(dataLen);
  let pos = 0;
  data.writeUInt8(1, pos); pos += 1;
  data.writeUInt32LE(nameBytes.length, pos); pos += 4; nameBytes.copy(data, pos); pos += nameBytes.length;
  data.writeUInt32LE(uriBytes.length, pos); pos += 4; uriBytes.copy(data, pos); pos += uriBytes.length;
  data.writeUInt8(0, pos);
  const ix = new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: collectionKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: agentWallet, isSigner: false, isWritable: false },
      { pubkey: ownerPubkey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(ix);
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = ownerPubkey;
  return { tx, collectionKeypair };
}

async function buildMintNftToCollectionTx(connection, domainAsset, ownerPubkey, nftName, nftUri, nftCollection, domainCollection) {
  const agentWallet = getAssetSignerPda(domainAsset);
  const mintKeypair = Keypair.generate();
  const nameBytes = Buffer.from(nftName, "utf-8");
  const uriBytes = Buffer.from(nftUri, "utf-8");
  const dataLen = 1 + 1 + 4 + nameBytes.length + 4 + uriBytes.length + 1;
  const data = Buffer.alloc(dataLen);
  let pos = 0;
  data.writeUInt8(0, pos); pos += 1;
  data.writeUInt8(0, pos); pos += 1;
  data.writeUInt32LE(nameBytes.length, pos); pos += 4; nameBytes.copy(data, pos); pos += nameBytes.length;
  data.writeUInt32LE(uriBytes.length, pos); pos += 4; uriBytes.copy(data, pos); pos += uriBytes.length;
  data.writeUInt8(0, pos);
  const innerIx = new TransactionInstruction({
    programId: MPL_CORE_PROGRAM_ID,
    keys: [
      { pubkey: mintKeypair.publicKey, isSigner: true, isWritable: true },
      { pubkey: nftCollection, isSigner: false, isWritable: true },
      { pubkey: agentWallet, isSigner: true, isWritable: false },
      { pubkey: ownerPubkey, isSigner: true, isWritable: true },
      { pubkey: agentWallet, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const tx = new Transaction().add(buildExecuteV1Instruction(domainAsset, domainCollection, ownerPubkey, ownerPubkey, innerIx));
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = ownerPubkey;
  return { tx, mintKeypair };
}

// ─── Build Tx from Queued Op ─────────────────────────────────────────

async function buildTxFromQueuedOp(connection, asset, owner, op, tokenBalances) {
  const p = op.params || {};
  let extraSigners = [];

  switch (op.action) {
    case "fund": {
      const tx = await buildFundAgentWalletTx(connection, asset, owner, parseFloat(p.amount));
      return { tx, extraSigners };
    }
    case "transfer-sol": {
      const tx = await buildAgentTransferSolTx(connection, asset, owner, new PublicKey(p.recipient), parseFloat(p.amount));
      return { tx, extraSigners };
    }
    case "transfer-token": {
      const mint = new PublicKey(p.mint);
      const bal = tokenBalances.find((b) => b.mint.equals(mint));
      const decimals = bal ? bal.decimals : 9;
      const raw = BigInt(Math.floor(parseFloat(p.amount) * 10 ** decimals));
      const tx = await buildAgentTransferTokenTx(connection, asset, owner, mint, new PublicKey(p.recipient), raw);
      return { tx, extraSigners };
    }
    case "create-token": {
      const decimals = parseInt(p.decimals || "9", 10);
      const { tx, mintKeypair } = await buildAgentCreateTokenTx(connection, asset, owner, decimals, p.name, p.symbol, p.uri);
      return { tx, extraSigners: [mintKeypair] };
    }
    case "mint-tokens": {
      const mint = new PublicKey(p.mint);
      const decimals = parseInt(p.decimals || "9", 10);
      const raw = BigInt(Math.floor(parseFloat(p.amount) * 10 ** decimals));
      const dest = p.destination ? new PublicKey(p.destination) : owner;
      const tx = await buildAgentMintTokensTx(connection, asset, owner, mint, dest, raw);
      return { tx, extraSigners };
    }
    case "burn-tokens": {
      const mint = new PublicKey(p.mint);
      const bal = tokenBalances.find((b) => b.mint.equals(mint));
      const decimals = bal ? bal.decimals : 9;
      const raw = BigInt(Math.floor(parseFloat(p.amount) * 10 ** decimals));
      const tx = await buildAgentBurnTokensTx(connection, asset, owner, mint, raw);
      return { tx, extraSigners };
    }
    case "close-accounts": {
      const closeable = await getAgentCloseableTokenAccounts(connection, asset);
      if (closeable.length === 0) throw new Error("No empty token accounts to close");
      const tx = await buildAgentCloseTokenAccountTx(connection, asset, owner, closeable[0].pubkey);
      return { tx, extraSigners };
    }
    case "mint-nft": {
      const { tx, mintKeypair } = await buildAgentMintNftTx(connection, asset, owner, p.name, p.uri);
      return { tx, extraSigners: [mintKeypair] };
    }
    case "transfer-nft": {
      const tx = await buildAgentTransferNftTx(connection, asset, owner, new PublicKey(p.nftAsset), new PublicKey(p.recipient));
      return { tx, extraSigners };
    }
    case "burn-nft": {
      const tx = await buildAgentBurnNftTx(connection, asset, owner, new PublicKey(p.nftAsset));
      return { tx, extraSigners };
    }
    case "create-collection": {
      const { tx, collectionKeypair } = await buildCreateCollectionTx(connection, asset, owner, p.name, p.uri);
      return { tx, extraSigners: [collectionKeypair] };
    }
    case "mint-nft-collection": {
      const { tx, mintKeypair } = await buildMintNftToCollectionTx(
        connection, asset, owner, p.name, p.uri, new PublicKey(p.collection), asset
      );
      return { tx, extraSigners: [mintKeypair] };
    }
    default:
      throw new Error(`Unknown action: ${op.action}`);
  }
}

// ─── Sign & Send ─────────────────────────────────────────────────────

async function signAndSend(connection, tx, signers) {
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

// ─── Queue API ───────────────────────────────────────────────────────

async function fetchPendingOps(userId) {
  const resp = await fetch(`${OPENCLAW_URL}/tx-queue/pending/${userId}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return data.ops || [];
}

async function reportComplete(opId, userId, signature, error) {
  try {
    await fetch(`${OPENCLAW_URL}/tx-queue/${opId}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, signature: signature || undefined, error: error || undefined }),
    });
  } catch { /* non-fatal */ }
}

// ─── Main Loop ───────────────────────────────────────────────────────

const OP_NAMES = {
  "fund": "Fund Wallet", "transfer-sol": "Transfer SOL", "transfer-token": "Transfer Token",
  "create-token": "Create Token", "mint-tokens": "Mint Tokens", "burn-tokens": "Burn Tokens",
  "close-accounts": "Close Accounts", "mint-nft": "Mint NFT", "transfer-nft": "Transfer NFT",
  "burn-nft": "Burn NFT", "create-collection": "Create Collection", "mint-nft-collection": "Mint to Collection",
};

async function main() {
  const opts = parseArgs();
  const keypair = loadKeypair(opts.key);
  const asset = new PublicKey(opts.asset);
  const userId = opts.user;
  const connection = new Connection(RPC_ENDPOINT, "confirmed");

  const walletInfo = await getAgentWalletInfo(connection, asset);

  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║          molt.id AutoPilot CLI                   ║
  ╚══════════════════════════════════════════════════╝

  Owner:        ${keypair.publicKey.toBase58()}
  Asset (NFT):  ${asset.toBase58()}
  Agent Wallet: ${walletInfo.walletPubkey.toBase58()}
  SOL Balance:  ${walletInfo.solBalance.toFixed(4)} SOL
  User ID:      ${userId}
  RPC:          ${RPC_ENDPOINT}
  Worker:       ${OPENCLAW_URL}
  Poll:         ${POLL_INTERVAL_MS}ms

  Polling for AI agent transactions...
  Press Ctrl+C to stop.
`);

  let processing = false;
  let tokenBalances = await getAgentTokenBalances(connection, asset);

  async function poll() {
    if (processing) return;
    try {
      const ops = await fetchPendingOps(userId);
      if (ops.length === 0) return;

      processing = true;
      const op = ops[0];
      const opName = OP_NAMES[op.action] || op.action;
      const ts = new Date().toLocaleTimeString();

      console.log(`[${ts}] [AI] ${opName}${op.aiMessage ? ` — "${op.aiMessage}"` : ""}`);

      try {
        const { tx, extraSigners } = await buildTxFromQueuedOp(connection, asset, keypair.publicKey, op, tokenBalances);
        const sig = await signAndSend(connection, tx, [keypair, ...extraSigners]);
        console.log(`[${ts}] OK  ${sig}`);
        console.log(`        https://solscan.io/tx/${sig}`);
        await reportComplete(op.id, userId, sig, null);

        // Refresh balances
        tokenBalances = await getAgentTokenBalances(connection, asset);
      } catch (err) {
        const msg = err.message || String(err);
        console.error(`[${ts}] ERR ${msg}`);
        await reportComplete(op.id, userId, null, msg);
      }
    } catch (err) {
      // Polling error — silently retry next cycle
    } finally {
      processing = false;
    }
  }

  // Run immediately, then poll
  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal:", err.message || err);
  process.exit(1);
});

#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

import {
  SuiClient,
  getFullnodeUrl,
} from "@mysten/sui/client";

import { Transaction } from "@mysten/sui/transactions";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

import {
  fromB64,
  normalizeSuiAddress,
  isValidSuiAddress,
} from "@mysten/sui/utils";

import { generateMnemonic, mnemonicToSeedSync } from "bip39";
import { derivePath } from "ed25519-hd-key";

/* =========================
   NETWORK CONFIG
========================= */
const NETWORKS = {
  mainnet: getFullnodeUrl("mainnet"),
  testnet: getFullnodeUrl("testnet"),
  devnet: getFullnodeUrl("devnet"),
  localnet: "http://127.0.0.1:9000",
};

let client: SuiClient;
let currentNetwork = "devnet";
let initialized = false;

function ensureClient() {
  if (!initialized) {
    client = new SuiClient({ url: NETWORKS[currentNetwork] });
    initialized = true;
  }
}

/* =========================
   WALLET STORE (DEV ONLY)
========================= */
const wallets = new Map<
  string,
  { keypair: Ed25519Keypair; mnemonic?: string }
>();

function getWallet(name: string) {
  const wallet = wallets.get(name);
  if (!wallet) throw new Error(`Wallet '${name}' not found`);
  return wallet;
}

function getAddress(wallet: { keypair: Ed25519Keypair }) {
  return wallet.keypair.getPublicKey().toSuiAddress();
}

/* =========================
   HELPERS
========================= */
function deriveKeypairFromMnemonic(mnemonic: string) {
  const seed = mnemonicToSeedSync(mnemonic);
  const { key } = derivePath("m/44'/784'/0'/0'/0'", seed.toString("hex"));
  return Ed25519Keypair.fromSecretKey(key);
}

function parsePrivateKey(pk: string) {
  if (pk.startsWith("0x")) {
    return new Uint8Array(Buffer.from(pk.slice(2), "hex"));
  }
  try {
    return fromB64(pk);
  } catch {
    return new Uint8Array(Buffer.from(pk, "hex"));
  }
}

/* =========================
   TOOL DEFINITIONS
========================= */
const tools: Tool[] = [
  { name: "create_wallet", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }},
  { name: "import_wallet", inputSchema: { type: "object", properties: { name: { type: "string" }, mnemonic: { type: "string" }, privateKey: { type: "string" } }, required: ["name"] }},
  { name: "list_wallets", inputSchema: { type: "object", properties: {} }},
  { name: "get_wallet_address", inputSchema: { type: "object", properties: { walletName: { type: "string" } }, required: ["walletName"] }},
  { name: "get_balance", inputSchema: { type: "object", properties: { walletName: { type: "string" } }, required: ["walletName"] }},
  { name: "get_all_balances", inputSchema: { type: "object", properties: { walletName: { type: "string" } }, required: ["walletName"] }},
  { name: "get_objects", inputSchema: { type: "object", properties: { walletName: { type: "string" } }, required: ["walletName"] }},
  { name: "get_object_details", inputSchema: { type: "object", properties: { objectId: { type: "string" } }, required: ["objectId"] }},
  { name: "transfer_sui", inputSchema: { type: "object", properties: { fromWallet: { type: "string" }, toAddress: { type: "string" }, amount: { type: "number" } }, required: ["fromWallet", "toAddress", "amount"] }},
  { name: "transfer_object", inputSchema: { type: "object", properties: { fromWallet: { type: "string" }, toAddress: { type: "string" }, objectId: { type: "string" } }, required: ["fromWallet", "toAddress", "objectId"] }},
  { name: "get_transaction", inputSchema: { type: "object", properties: { digest: { type: "string" } }, required: ["digest"] }},
  { name: "get_transactions", inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] }},
  { name: "get_wallet_transactions", inputSchema: { type: "object", properties: { walletName: { type: "string" } }, required: ["walletName"] }},
  { name: "get_gas_price", inputSchema: { type: "object", properties: {} }},
  { name: "switch_network", inputSchema: { type: "object", properties: { network: { type: "string" } }, required: ["network"] }},
  { name: "get_network_info", inputSchema: { type: "object", properties: {} }},
  { name: "validate_address", inputSchema: { type: "object", properties: { address: { type: "string" } }, required: ["address"] }},
];

/* =========================
   HANDLERS
========================= */

async function create_wallet({ name }: any) {
  if (wallets.has(name)) throw new Error("Wallet exists");

  const mnemonic = generateMnemonic();
  const keypair = deriveKeypairFromMnemonic(mnemonic);

  wallets.set(name, { keypair, mnemonic });

  return {
    name,
    address: getAddress({ keypair }),
    mnemonic,
  };
}

async function import_wallet({ name, mnemonic, privateKey }: any) {
  if (wallets.has(name)) throw new Error("Wallet exists");

  let keypair;

  if (mnemonic) keypair = deriveKeypairFromMnemonic(mnemonic);
  else if (privateKey) keypair = Ed25519Keypair.fromSecretKey(parsePrivateKey(privateKey));
  else throw new Error("Provide mnemonic or privateKey");

  wallets.set(name, { keypair });

  return { name, address: getAddress({ keypair }) };
}

async function list_wallets() {
  return Array.from(wallets.entries()).map(([name, w]) => ({
    name,
    address: getAddress(w),
  }));
}

async function get_balance({ walletName }: any) {
  ensureClient();
  const wallet = getWallet(walletName);
  const address = getAddress(wallet);

  const bal = await client.getBalance({ owner: address });

  return {
    address,
    sui: Number(bal.totalBalance) / 1e9,
  };
}

async function get_objects({ walletName }: any) {
  ensureClient();
  const wallet = getWallet(walletName);

  return await client.getOwnedObjects({
    owner: getAddress(wallet),
  });
}

async function transfer_sui({ fromWallet, toAddress, amount }: any) {
  ensureClient();

  const wallet = getWallet(fromWallet);

  const tx = new Transaction();

  const [coin] = tx.splitCoins(tx.gas, [amount * 1e9]);

  tx.transferObjects([coin], toAddress);

  const result = await client.signAndExecuteTransaction({
    signer: wallet.keypair,
    transaction: tx,
  });

  return result;
}

async function transfer_object({ fromWallet, toAddress, objectId }: any) {
  ensureClient();

  const wallet = getWallet(fromWallet);

  const tx = new Transaction();
  tx.transferObjects([tx.object(objectId)], toAddress);

  return await client.signAndExecuteTransaction({
    signer: wallet.keypair,
    transaction: tx,
  });
}

async function get_transaction({ digest }: any) {
  ensureClient();
  return await client.getTransactionBlock({ digest });
}

async function get_transactions({ address }: any) {
  ensureClient();
  return await client.queryTransactionBlocks({
    filter: { ToAddress: address },
  });
}

async function get_wallet_transactions({ walletName }: any) {
  const wallet = getWallet(walletName);
  return get_transactions({ address: getAddress(wallet) });
}

async function get_gas_price() {
  ensureClient();
  return await client.getReferenceGasPrice();
}

async function switch_network({ network }: any) {
  if (!NETWORKS[network]) throw new Error("Invalid network");

  currentNetwork = network;
  initialized = false;

  return { network };
}

async function get_network_info() {
  ensureClient();
  return {
    network: currentNetwork,
    rpc: NETWORKS[currentNetwork],
    chainId: await client.getChainIdentifier(),
  };
}

async function validate_address({ address }: any) {
  return {
    valid: isValidSuiAddress(address),
    normalized: isValidSuiAddress(address)
      ? normalizeSuiAddress(address)
      : null,
  };
}

/* =========================
   MCP SERVER
========================= */

const server = new Server(
  { name: "sui-mcp-server", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  const map: any = {
    create_wallet,
    import_wallet,
    list_wallets,
    get_balance,
    get_objects,
    transfer_sui,
    transfer_object,
    get_transaction,
    get_transactions,
    get_wallet_transactions,
    get_gas_price,
    switch_network,
    get_network_info,
    validate_address,
  };

  try {
    if (!map[name]) throw new Error("Unknown tool");

    const result = await map[name](args);

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e: any) {
    return {
      content: [{ type: "text", text: e.message }],
      isError: true,
    };
  }
});

/* =========================
   START
========================= */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();

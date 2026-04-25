/**
 * Trader Agent Template — utility functions.
 *
 * Canonical JSON, intent ID computation, description encoding/parsing,
 * and validation helpers.
 */

import { createHash } from 'node:crypto';
import type { CreateIntentParams } from './acp-types.js';
import type { DealTerms, TradingIntent } from './types.js';
export { hasDangerousKeys } from '../protocols/envelope.js';

// ---------------------------------------------------------------------------
// Canonical JSON (JCS-compatible: sorted keys, no whitespace)
// ---------------------------------------------------------------------------

export function canonicalJson(obj: unknown): string {
  return JSON.stringify(obj, (_key, value: unknown) => {
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  });
}

// ---------------------------------------------------------------------------
// Intent ID derivation (spec Section 2.5)
// ---------------------------------------------------------------------------

export function computeIntentId(intent: {
  readonly agent_pubkey: string;
  readonly agent_address: string;
  readonly salt: string;
  readonly direction: 'buy' | 'sell';
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly rate_min: bigint;
  readonly rate_max: bigint;
  readonly volume_min: bigint;
  readonly volume_max: bigint;
  readonly escrow_address: string;
  readonly deposit_timeout_sec: number;
  readonly expiry_ms: number;
  readonly created_ms: number;
}): string {
  const hashInput = canonicalJson({
    agent_address: intent.agent_address,
    agent_pubkey: intent.agent_pubkey,
    base_asset: intent.base_asset,
    created_ms: intent.created_ms,
    deposit_timeout_sec: intent.deposit_timeout_sec,
    direction: intent.direction,
    escrow_address: intent.escrow_address,
    expiry_ms: intent.expiry_ms,
    quote_asset: intent.quote_asset,
    rate_max: intent.rate_max,
    rate_min: intent.rate_min,
    salt: intent.salt,
    volume_max: intent.volume_max,
    volume_min: intent.volume_min,
  });
  return createHash('sha256').update(hashInput).digest('hex');
}

// ---------------------------------------------------------------------------
// Description encoding (spec Section 2.8)
// ---------------------------------------------------------------------------

export function encodeDescription(intent: TradingIntent): string {
  const verb = intent.direction === 'sell' ? 'Selling' : 'Buying';
  return [
    `${verb} ${intent.volume_min.toString()}-${intent.volume_max.toString()} ${intent.base_asset} for ${intent.quote_asset}.`,
    `Rate: ${intent.rate_min.toString()}-${intent.rate_max.toString()} ${intent.quote_asset} per ${intent.base_asset}.`,
    `Escrow: ${intent.escrow_address}.`,
    `Deposit timeout: ${String(intent.deposit_timeout_sec)}s.`,
    `Expires: ${String(intent.expiry_ms)}.`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Description parsing (reverse of encodeDescription)
// ---------------------------------------------------------------------------

export interface ParsedDescription {
  readonly direction: 'buy' | 'sell';
  readonly base_asset: string;
  readonly quote_asset: string;
  readonly volume_min: bigint;
  readonly volume_max: bigint;
  readonly rate_min: bigint;
  readonly rate_max: bigint;
  readonly escrow_address: string;
  readonly deposit_timeout_sec: number;
  /** Epoch ms when the intent expires. 0 if not present (legacy descriptions). */
  readonly expiry_ms: number;
}

const HEADER_RE = /^(Selling|Buying)\s+(\d+)-(\d+)\s+([A-Z0-9_]+)\s+for\s+([A-Z0-9_]+)\./;
const RATE_RE = /^Rate:\s+(\d+)-(\d+)\s+[A-Z0-9_]+\s+per\s+[A-Z0-9_]+\./;
// Escrow address: alphanumeric + common address chars, but no '..' sequences
const ESCROW_RE = /^Escrow:\s+([A-Za-z0-9_:/@-]+(?:\.[A-Za-z0-9_:/@-]+)*)\./;
const TIMEOUT_RE = /^Deposit timeout:\s+(\d+)s\./;
const EXPIRY_RE = /^Expires:\s+(\d+)\./;

export function parseDescription(desc: string): ParsedDescription | null {
  // Support both `. ` sentence separator (current format) and `\n` separator (legacy)
  const lines = desc.includes('\n')
    ? desc.split('\n')
    : desc.split(/(?<=\.)\s+(?=[A-Z])/);
  const line0 = lines[0];
  const line1 = lines[1];
  const line2 = lines[2];
  const line3 = lines[3];
  const line4 = lines[4]; // optional — expiry_ms (new format)
  if (!line0 || !line1 || !line2 || !line3) return null;

  const headerMatch = HEADER_RE.exec(line0);
  if (!headerMatch) return null;

  const rateMatch = RATE_RE.exec(line1);
  if (!rateMatch) return null;

  const escrowMatch = ESCROW_RE.exec(line2);
  if (!escrowMatch) return null;

  const timeoutMatch = TIMEOUT_RE.exec(line3);
  if (!timeoutMatch) return null;

  // Parse optional expiry line (backward-compatible with legacy 4-line format)
  let expiryMs = 0;
  if (line4) {
    const expiryMatch = EXPIRY_RE.exec(line4);
    if (expiryMatch?.[1]) {
      expiryMs = Number(expiryMatch[1]);
    }
  }

  const verb = headerMatch[1];
  const volMin = headerMatch[2];
  const volMax = headerMatch[3];
  const baseAsset = headerMatch[4];
  const quoteAsset = headerMatch[5];
  const rMin = rateMatch[1];
  const rMax = rateMatch[2];
  const escrow = escrowMatch[1];
  const timeout = timeoutMatch[1];

  if (!verb || !volMin || !volMax || !baseAsset || !quoteAsset ||
      !rMin || !rMax || !escrow || !timeout) {
    return null;
  }

  return {
    direction: verb === 'Selling' ? 'sell' : 'buy',
    base_asset: baseAsset,
    quote_asset: quoteAsset,
    volume_min: BigInt(volMin),
    volume_max: BigInt(volMax),
    rate_min: BigInt(rMin),
    rate_max: BigInt(rMax),
    escrow_address: escrow,
    deposit_timeout_sec: Number(timeout),
    expiry_ms: expiryMs,
  };
}

// ---------------------------------------------------------------------------
// Validation: CREATE_INTENT params
// ---------------------------------------------------------------------------

const MAX_EXPIRY_SEC = 7 * 24 * 60 * 60; // 7 days

export function validateIntentParams(params: CreateIntentParams): string | null {
  let rateMin: bigint;
  let rateMax: bigint;
  let volumeMin: bigint;
  let volumeMax: bigint;
  try {
    rateMin = BigInt(params.rate_min);
    rateMax = BigInt(params.rate_max);
    volumeMin = BigInt(params.volume_min);
    volumeMax = BigInt(params.volume_max);
  } catch {
    return 'rate and volume parameters must be valid integer strings';
  }

  if (rateMin <= 0n) return 'rate_min must be positive';
  if (rateMax <= 0n) return 'rate_max must be positive';
  if (rateMin > rateMax) return 'rate_min must be <= rate_max';
  if (volumeMin <= 0n) return 'volume_min must be positive';
  if (volumeMax <= 0n) return 'volume_max must be positive';
  if (volumeMin > volumeMax) return 'volume_min must be <= volume_max';

  if (!Number.isFinite(params.expiry_sec)) return 'expiry_sec must be finite';
  if (params.expiry_sec <= 0) return 'expiry_sec must be positive';
  if (params.expiry_sec > MAX_EXPIRY_SEC) return 'expiry_sec must not exceed 7 days';

  if (params.deposit_timeout_sec !== undefined) {
    if (!Number.isInteger(params.deposit_timeout_sec)) return 'deposit_timeout_sec must be an integer';
    if (params.deposit_timeout_sec < 30 || params.deposit_timeout_sec > 300) {
      return 'deposit_timeout_sec must be between 30 and 300';
    }
  }

  if (params.direction !== 'buy' && params.direction !== 'sell') {
    return 'direction must be "buy" or "sell"';
  }

  if (params.base_asset === params.quote_asset) {
    return 'base_asset and quote_asset must differ';
  }

  const ASSET_RE = /^[A-Z0-9_]{1,32}$/;
  if (!ASSET_RE.test(params.base_asset)) return 'base_asset must match /^[A-Z0-9_]{1,32}$/';
  if (!ASSET_RE.test(params.quote_asset)) return 'quote_asset must match /^[A-Z0-9_]{1,32}$/';

  return null;
}

// ---------------------------------------------------------------------------
// Validation: DealTerms
// ---------------------------------------------------------------------------

export function validateDealTerms(terms: DealTerms): string | null {
  if (!terms.deal_id || typeof terms.deal_id !== 'string') return 'deal_id is required';
  if (!terms.proposer_intent_id) return 'proposer_intent_id is required';
  if (!terms.acceptor_intent_id) return 'acceptor_intent_id is required';
  if (!terms.proposer_pubkey) return 'proposer_pubkey is required';
  if (!terms.acceptor_pubkey) return 'acceptor_pubkey is required';
  if (!terms.proposer_address) return 'proposer_address is required';
  if (!terms.acceptor_address) return 'acceptor_address is required';
  if (!terms.base_asset) return 'base_asset is required';
  if (!terms.quote_asset) return 'quote_asset is required';
  if (terms.rate <= 0n) return 'rate must be positive';
  if (terms.volume <= 0n) return 'volume must be positive';
  if (terms.proposer_direction !== 'buy' && terms.proposer_direction !== 'sell') {
    return 'proposer_direction must be "buy" or "sell"';
  }
  if (!terms.escrow_address) return 'escrow_address is required';
  if (!Number.isInteger(terms.deposit_timeout_sec) || terms.deposit_timeout_sec < 30 || terms.deposit_timeout_sec > 300) {
    return 'deposit_timeout_sec must be an integer between 30 and 300';
  }
  if (!Number.isFinite(terms.created_ms) || terms.created_ms <= 0) {
    return 'created_ms must be a positive number';
  }
  return null;
}

/**
 * Unit tests for `fundWallet`. The faucet is stubbed via `vi.stubGlobal` on
 * `fetch` — we never hit the network. Each test resets the stub so order
 * doesn't matter.
 *
 * Coverage:
 *   - request body shape (unicityId, coin, amount-as-string)
 *   - URL + content-type
 *   - happy-path tx_id extraction
 *   - default coin id is 'UCT'
 *   - 4xx fast-fails (no retry)
 *   - 5xx retries up to MAX_ATTEMPTS then throws
 *   - missing tx_id in success body throws clearly
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fundWallet } from './funding.js';
import { FAUCET_URL } from './constants.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe('fundWallet', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('POSTs to FAUCET_URL with correct body and Content-Type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { tx_id: 'abc123' }));

    await fundWallet('alice', 5_000_000n, 'UCT');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(FAUCET_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const parsed = JSON.parse(init.body);
    expect(parsed).toEqual({
      unicityId: 'alice',
      coin: 'UCT',
      amount: '5000000',
    });
    // bigint must be serialised as a string, not a number.
    expect(typeof parsed.amount).toBe('string');
  });

  it('returns the tx_id from the response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { tx_id: 'deadbeef' }));
    const result = await fundWallet('alice', 1n);
    expect(result).toEqual({ tx_id: 'deadbeef' });
  });

  it('defaults coinId to UCT when omitted', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { tx_id: 'x' }));
    await fundWallet('alice', 1n);
    const init = fetchMock.mock.calls[0]![1];
    const parsed = JSON.parse(init.body);
    expect(parsed.coin).toBe('UCT');
  });

  it('passes through a custom coinId when provided', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { tx_id: 'x' }));
    await fundWallet('alice', 1n, 'USDU');
    const init = fetchMock.mock.calls[0]![1];
    const parsed = JSON.parse(init.body);
    expect(parsed.coin).toBe('USDU');
  });

  it('fast-fails on 4xx without retry', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(400, 'nametag not found'));

    await expect(fundWallet('nope', 1n)).rejects.toThrow(/Faucet returned 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx then succeeds on the third attempt', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(textResponse(503, 'service unavailable'))
      .mockResolvedValueOnce(textResponse(502, 'bad gateway'))
      .mockResolvedValueOnce(jsonResponse(200, { tx_id: 'recovered' }));

    const promise = fundWallet('alice', 1n);
    // Drain backoffs (1s + 2s = 3s); use a generous advance to be safe.
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result).toEqual({ tx_id: 'recovered' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws after MAX_ATTEMPTS of 5xx', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(textResponse(500, 'oops'))
      .mockResolvedValueOnce(textResponse(500, 'oops'))
      .mockResolvedValueOnce(textResponse(500, 'still oops'));

    const promise = fundWallet('alice', 1n);
    // Attach a rejection handler IMMEDIATELY so vitest doesn't see a
    // momentary unhandled rejection while we drive the fake timers.
    const settled = expect(promise).rejects.toThrow(/Faucet returned 500/);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries on network errors (fetch throws)', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse(200, { tx_id: 'ok-after-network-err' }));

    const promise = fundWallet('alice', 1n);
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await promise;
    expect(result).toEqual({ tx_id: 'ok-after-network-err' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws on success body missing tx_id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { other: 'field' }));
    await expect(fundWallet('alice', 1n)).rejects.toThrow(
      /missing tx_id/i,
    );
  });

  it('throws on success body that is not JSON', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(200, 'OK plain text'));
    await expect(fundWallet('alice', 1n)).rejects.toThrow(
      /non-JSON success body/i,
    );
  });

  it('serialises very large bigint amounts losslessly', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { tx_id: 'x' }));
    // 2^60 — well past Number.MAX_SAFE_INTEGER, must round-trip as string.
    const big = 1_152_921_504_606_846_976n;
    await fundWallet('alice', big);
    const init = fetchMock.mock.calls[0]![1];
    const parsed = JSON.parse(init.body);
    expect(parsed.amount).toBe(big.toString());
  });
});

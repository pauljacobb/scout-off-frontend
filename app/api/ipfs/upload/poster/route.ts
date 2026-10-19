import { NextRequest } from 'next/server';
import { privateJson } from '@/lib/httpResponses';
import { getSessionWallet } from '@/lib/session';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { createRequestLogger } from '@/lib/logger';
import {
  getPinataCredentials,
  getMissingPinataEnvVars,
  PINATA_NOT_CONFIGURED_ERROR,
} from '@/lib/pinataConfig';
import {
  extractPosterFrameFromBuffer,
  posterCacheKey,
} from '@/lib/videoPosterFrame';
import { pinStreamedFileToIPFS } from '@/app/api/ipfs/upload/complete/route';

export const runtime = 'nodejs';

/**
 * POST /api/ipfs/upload/poster
 *
 * Generates a server-side poster-frame thumbnail for a highlight video at
 * upload time (issue #1481), eliminating per-viewer range requests and
 * client-side canvas decoding.
 *
 * Request body (JSON):
 *   { videoCid: string, seekSeconds?: number }
 *
 * The endpoint:
 *   1. Fetches the first 8 MB of the video from the configured IPFS gateway
 *      (a targeted byte-range request — the entire file is never downloaded).
 *   2. Calls `extractPosterFrameFromBuffer()` to detect the container format
 *      and produce a JPEG thumbnail (or a deterministic placeholder for
 *      unrecognised containers).
 *   3. Pins the resulting JPEG to IPFS via Pinata and returns its CID.
 *
 * The poster CID is stable: pinning the same bytes always yields the same
 * CID, so concurrent calls for the same video are idempotent and the result
 * is automatically cached at the gateway layer.
 *
 * Response:
 *   201 { posterCid: string, width: number, height: number,
 *          timestampSeconds: number, cacheKey: string }
 *   400 { error: string }  — missing / invalid body
 *   429 { error: string }  — rate limited
 *   502 { error: string }  — gateway or Pinata failure
 *   503 { error: string }  — Pinata not configured
 */
const RATE_LIMIT = { limit: 10, windowMs: 60 * 1000 };

/** Byte range to fetch from the IPFS gateway for container scanning. */
const HEADER_SCAN_BYTES = 8 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const log = createRequestLogger(req);
  const pinata = getPinataCredentials();
  if (!pinata) {
    log.error('Pinata credentials missing; poster generation disabled', {
      missing: getMissingPinataEnvVars().join(', '),
    });
    return privateJson({ error: PINATA_NOT_CONFIGURED_ERROR }, { status: 503 });
  }

  const wallet = getSessionWallet(req);
  const ip = getClientIp(req);
  const key = wallet ? `wallet:${wallet}` : ip;
  const rl = await checkRateLimit(`ipfs-poster:${key}`, RATE_LIMIT);
  if (rl.limited) {
    const retryAfter = rl.retryAfterSec ?? 60;
    return privateJson(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return privateJson({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { videoCid, seekSeconds } = (body ?? {}) as Record<string, unknown>;

  if (typeof videoCid !== 'string' || !videoCid.trim()) {
    return privateJson({ error: 'videoCid is required' }, { status: 400 });
  }

  const seek =
    typeof seekSeconds === 'number' && Number.isFinite(seekSeconds)
      ? Math.max(0, seekSeconds)
      : 1;

  const cacheKey = posterCacheKey(videoCid, seek);

  // Fetch the leading bytes of the video from the IPFS gateway.
  // We use a byte-range request so we never download the whole file.
  const gatewayBase =
    process.env.IPFS_GATEWAY_URL ?? 'https://gateway.pinata.cloud/ipfs';
  const videoUrl = `${gatewayBase.replace(/\/$/, '')}/${videoCid}`;

  let videoBytes: Uint8Array;
  try {
    const response = await fetch(videoUrl, {
      headers: { Range: `bytes=0-${HEADER_SCAN_BYTES - 1}` },
    });
    if (!response.ok && response.status !== 206) {
      log.warn('Gateway range request failed', {
        videoCid,
        status: response.status,
      });
      return privateJson(
        { error: 'Failed to fetch video from IPFS gateway' },
        { status: 502 },
      );
    }
    const arrayBuffer = await response.arrayBuffer();
    videoBytes = new Uint8Array(arrayBuffer);
  } catch (err) {
    log.error('Gateway fetch error', {
      videoCid,
      reason: err instanceof Error ? err.message : String(err),
    });
    return privateJson(
      { error: 'Failed to fetch video from IPFS gateway' },
      { status: 502 },
    );
  }

  // Extract poster frame from the scanned bytes.
  const frame = extractPosterFrameFromBuffer(videoBytes, seek);

  // Pin the JPEG to IPFS.
  let posterCid: string;
  try {
    const posterBuffer = frame.jpeg;
    const filename = `poster-${cacheKey}.jpg`;
    posterCid = await pinStreamedFileToIPFS({
      filename,
      fileType: 'image/jpeg',
      totalBytes: posterBuffer.length,
      chunks: function* () {
        yield posterBuffer;
      },
    });
  } catch (err) {
    log.error('Poster pin failed', {
      videoCid,
      reason: err instanceof Error ? err.message : String(err),
    });
    return privateJson(
      { error: 'Failed to pin poster to IPFS' },
      { status: 502 },
    );
  }

  return privateJson(
    {
      posterCid,
      width: frame.width,
      height: frame.height,
      timestampSeconds: frame.timestampSeconds,
      cacheKey,
    },
    { status: 201 },
  );
}

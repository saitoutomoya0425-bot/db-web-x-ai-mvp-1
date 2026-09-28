import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SourceAwareInterleaveIndex } from "./source-aware.ts";

export type SourceAwareCursorKind = "catalog" | "search";

export type SourceAwareCursorState = {
  version: 1;
  kind: SourceAwareCursorKind;
  contextHash: string;
  fanzaOffset: number;
  myFansAfter: string | null;
  fanzaExhausted: boolean;
  myFansExhausted: boolean;
  interleaveIndex: SourceAwareInterleaveIndex;
};

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_OFFSET = 10_000_000;

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signature(encodedPayload: string, secret: string) {
  return createHmac("sha256", secret).update(encodedPayload, "utf8").digest("base64url");
}

function isCursorState(value: unknown): value is SourceAwareCursorState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<SourceAwareCursorState>;
  return state.version === 1
    && (state.kind === "catalog" || state.kind === "search")
    && typeof state.contextHash === "string"
    && HASH_PATTERN.test(state.contextHash)
    && Number.isSafeInteger(state.fanzaOffset)
    && Number(state.fanzaOffset) >= 0
    && Number(state.fanzaOffset) <= MAX_OFFSET
    && (state.myFansAfter === null || (typeof state.myFansAfter === "string" && UUID_PATTERN.test(state.myFansAfter)))
    && typeof state.fanzaExhausted === "boolean"
    && typeof state.myFansExhausted === "boolean"
    && Number.isInteger(state.interleaveIndex)
    && Number(state.interleaveIndex) >= 0
    && Number(state.interleaveIndex) <= 3;
}

export function sourceAwareContextHash(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function encodeSourceAwareCursor(state: SourceAwareCursorState, secret: string) {
  if (!isCursorState(state) || !secret) throw new Error("INVALID_SOURCE_AWARE_CURSOR_STATE");
  const payload = JSON.stringify({
    version: state.version,
    kind: state.kind,
    contextHash: state.contextHash,
    fanzaOffset: state.fanzaOffset,
    myFansAfter: state.myFansAfter,
    fanzaExhausted: state.fanzaExhausted,
    myFansExhausted: state.myFansExhausted,
    interleaveIndex: state.interleaveIndex,
  });
  const encodedPayload = base64UrlEncode(payload);
  return `${encodedPayload}.${signature(encodedPayload, secret)}`;
}

export function decodeSourceAwareCursor(
  cursor: string,
  expected: { kind: SourceAwareCursorKind; contextHash: string },
  secret: string,
): SourceAwareCursorState | null {
  if (!cursor || !secret || cursor.length > 2048) return null;
  const parts = cursor.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const actualSignature = Buffer.from(parts[1], "base64url");
  const expectedSignature = Buffer.from(signature(parts[0], secret), "base64url");
  if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) return null;
  try {
    const state = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!isCursorState(state)) return null;
    if (state.kind !== expected.kind || state.contextHash !== expected.contextHash) return null;
    return state;
  } catch {
    return null;
  }
}

export function initialSourceAwareCursorState(options: {
  kind: SourceAwareCursorKind;
  contextHash: string;
  myFansExhausted?: boolean;
}): SourceAwareCursorState {
  return {
    version: 1,
    kind: options.kind,
    contextHash: options.contextHash,
    fanzaOffset: 0,
    myFansAfter: null,
    fanzaExhausted: false,
    myFansExhausted: options.myFansExhausted ?? false,
    interleaveIndex: 0,
  };
}

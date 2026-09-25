(function installMyFansExportArtifacts(global) {
  "use strict";

  const ARTIFACT_SCHEMA_VERSION = "myfans-export-artifact-v1";
  const ARTIFACT_TYPES = Object.freeze({
    RUN: "RUN",
    CUMULATIVE: "CUMULATIVE"
  });
  const DELIVERY_STATES = Object.freeze({
    GENERATED: "GENERATED",
    CLAIMED: "CLAIMED",
    DELIVERING: "DELIVERING",
    DELIVERED: "DELIVERED",
    DELIVERY_FAILED: "DELIVERY_FAILED",
    DELIVERY_AMBIGUOUS: "DELIVERY_AMBIGUOUS"
  });
  const FILE_PREFIXES = Object.freeze({
    RUN: "myfans-affiliate-catalog-run",
    CUMULATIVE: "myfans-affiliate-catalog-cumulative"
  });

  function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    );
  }

  function canonicalSerializedText(value) {
    const serialized = JSON.stringify(canonicalize(value), null, 2);
    if (typeof serialized !== "string") throw new Error("EXPORT_SERIALIZATION_FAILED");
    return `${serialized.replace(/\n+$/u, "")}\n`;
  }

  function utf8Bytes(value) {
    if (typeof global.TextEncoder !== "function") throw new Error("TEXT_ENCODER_UNAVAILABLE");
    return new global.TextEncoder().encode(String(value));
  }

  async function sha256Utf8(value) {
    if (!global.crypto?.subtle) throw new Error("WEB_CRYPTO_UNAVAILABLE");
    const digest = await global.crypto.subtle.digest("SHA-256", utf8Bytes(value));
    return `sha256:${[...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
  }

  function stableFilename(artifactType, logicalValue, generatedAt) {
    const prefix = FILE_PREFIXES[artifactType];
    if (!prefix) throw new Error("EXPORT_ARTIFACT_TYPE_INVALID");
    const timestamp = String(logicalValue?.collected_at || generatedAt || "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(timestamp)) {
      throw new Error("EXPORT_ARTIFACT_TIMESTAMP_INVALID");
    }
    return `${prefix}-${timestamp.replace(/[:.]/gu, "-")}.json`;
  }

  async function serializeExportArtifact(logicalValue, options = {}) {
    const artifactType = options.artifact_type;
    const serializedText = canonicalSerializedText(logicalValue);
    const bytes = utf8Bytes(serializedText);
    return {
      artifact_schema_version: ARTIFACT_SCHEMA_VERSION,
      artifact_type: artifactType,
      filename: stableFilename(artifactType, logicalValue, options.generated_at),
      serialized_text: serializedText,
      byte_length: bytes.byteLength,
      content_hash: await sha256Utf8(serializedText),
      generated_at: String(options.generated_at || logicalValue?.collected_at || ""),
      generation_state: "GENERATED",
      delivery_state: DELIVERY_STATES.GENERATED,
      claim_token: null,
      delivery_attempts: 0,
      claimed_at: null,
      delivery_started_at: null,
      delivered_at: null,
      delivery_failure_reason: null
    };
  }

  async function verifyExportArtifact(artifact) {
    if (!artifact || artifact.artifact_schema_version !== ARTIFACT_SCHEMA_VERSION) {
      throw new Error("EXPORT_ARTIFACT_SCHEMA_INVALID");
    }
    if (!FILE_PREFIXES[artifact.artifact_type]) throw new Error("EXPORT_ARTIFACT_TYPE_INVALID");
    if (typeof artifact.serialized_text !== "string") throw new Error("EXPORT_ARTIFACT_TEXT_MISSING");
    if (!artifact.serialized_text.endsWith("\n") || artifact.serialized_text.endsWith("\n\n")) {
      throw new Error("EXPORT_ARTIFACT_NEWLINE_INVALID");
    }
    let logicalValue;
    try {
      logicalValue = JSON.parse(artifact.serialized_text);
    } catch {
      throw new Error("EXPORT_ARTIFACT_JSON_INVALID");
    }
    if (canonicalSerializedText(logicalValue) !== artifact.serialized_text) {
      throw new Error("EXPORT_ARTIFACT_NOT_CANONICAL");
    }
    if (stableFilename(artifact.artifact_type, logicalValue, artifact.generated_at) !== artifact.filename) {
      throw new Error("EXPORT_ARTIFACT_FILENAME_MISMATCH");
    }
    const bytes = utf8Bytes(artifact.serialized_text);
    if (bytes.byteLength !== artifact.byte_length) throw new Error("EXPORT_ARTIFACT_BYTE_LENGTH_MISMATCH");
    const contentHash = await sha256Utf8(artifact.serialized_text);
    if (contentHash !== artifact.content_hash) throw new Error("EXPORT_ARTIFACT_HASH_MISMATCH");
    return true;
  }

  global.MyFansExportArtifacts = Object.freeze({
    ARTIFACT_SCHEMA_VERSION,
    ARTIFACT_TYPES,
    DELIVERY_STATES,
    canonicalSerializedText,
    canonicalize,
    serializeExportArtifact,
    sha256Utf8,
    stableFilename,
    utf8Bytes,
    verifyExportArtifact
  });
})(globalThis);

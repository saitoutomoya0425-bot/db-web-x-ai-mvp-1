(function installMyFansDownloadDelivery(global) {
  "use strict";

  const DATA_URL_PREFIX = "data:application/json;charset=utf-8;base64,";

  function utf8Bytes(value) {
    if (typeof global.TextEncoder !== "function") throw new Error("TEXT_ENCODER_UNAVAILABLE");
    return new global.TextEncoder().encode(String(value));
  }

  function bytesToBase64(bytes) {
    if (typeof global.btoa !== "function") throw new Error("BASE64_ENCODER_UNAVAILABLE");
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return global.btoa(binary);
  }

  function artifactDataUrl(artifact) {
    if (!artifact || typeof artifact.serialized_text !== "string") {
      throw new Error("EXPORT_ARTIFACT_TEXT_MISSING");
    }
    return `${DATA_URL_PREFIX}${bytesToBase64(utf8Bytes(artifact.serialized_text))}`;
  }

  function downloadOptions(artifact) {
    if (!artifact?.filename) throw new Error("EXPORT_ARTIFACT_FILENAME_MISSING");
    return {
      url: artifactDataUrl(artifact),
      filename: artifact.filename,
      saveAs: false,
      conflictAction: "uniquify"
    };
  }

  function basename(value) {
    return String(value || "").split(/[\\/]/u).at(-1) || "";
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }

  function filenameMatchesRequested(actualFilename, requestedFilename) {
    const actual = basename(actualFilename);
    const requested = basename(requestedFilename);
    if (!actual || !requested) return false;
    if (actual === requested) return true;
    const dot = requested.lastIndexOf(".");
    const stem = dot > 0 ? requested.slice(0, dot) : requested;
    const extension = dot > 0 ? requested.slice(dot) : "";
    return new RegExp(`^${escapeRegex(stem)} \\(\\d+\\)${escapeRegex(extension)}$`, "u").test(actual);
  }

  function observedByteLength(item) {
    for (const value of [item?.fileSize, item?.totalBytes, item?.bytesReceived]) {
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
    return null;
  }

  function validateCompletedDownload(item, artifact) {
    if (!item || item.id !== artifact.download_id) throw new Error("DOWNLOAD_ID_MISMATCH");
    if (item.state !== "complete") throw new Error("DOWNLOAD_NOT_COMPLETE");
    if (item.exists !== true) throw new Error("DOWNLOADED_FILE_NOT_PRESENT");
    if (!filenameMatchesRequested(item.filename, artifact.filename)) {
      throw new Error("DOWNLOADED_FILENAME_MISMATCH");
    }
    const byteLength = observedByteLength(item);
    if (byteLength == null) throw new Error("DOWNLOADED_BYTE_LENGTH_UNAVAILABLE");
    if (byteLength !== artifact.byte_length) throw new Error("DOWNLOADED_BYTE_LENGTH_MISMATCH");
    return {
      actual_resolved_filename: item.filename,
      observed_byte_length: byteLength,
      exists: true
    };
  }

  global.MyFansDownloadDelivery = Object.freeze({
    DATA_URL_PREFIX,
    artifactDataUrl,
    basename,
    downloadOptions,
    filenameMatchesRequested,
    observedByteLength,
    utf8Bytes,
    validateCompletedDownload
  });
})(globalThis);

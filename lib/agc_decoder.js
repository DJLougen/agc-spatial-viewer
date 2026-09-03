/**
 * Zero-install standalone JavaScript / Web decoder for Adaptive Geometric Compression (.agc, .agz) archives.
 * Works seamlessly in Browser (Web APIs / Three.js / WebGL) and Node.js / Bun environments.
 */

(function (root, factory) {
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AGCDecoder = factory();
    // Exported as AGCDecoder
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAGIC_V1 = 0x3153474b; // "KGS1"
  const MAGIC_V2 = 0x3253474b; // "KGS2"
  const MAGIC_KGZ1 = 0x315a474b; // "KGZ1"
  const MAGIC_KGZ2 = 0x325a474b; // "KGZ2"
  const MAGIC_AGC1 = 0x31434741; // "AGC1"
  const MAGIC_AGC2 = 0x32434741; // "AGC2"
  const MAGIC_AGZ1 = 0x315a4741; // "AGZ1"
  const MAGIC_AGZ2 = 0x325a4741; // "AGZ2"
  const MAGIC_KGX1 = 0x3158474b; // "KGX1"
  const MAGIC_KGX2 = 0x3258474b; // "KGX2"
  const MAGIC_AGX1 = 0x31584741; // "AGX1"
  const MAGIC_AGX2 = 0x32584741; // "AGX2"
  const MAGIC_PKGS = 0x53474b50; // "PKGS"
  const MAGIC_AGP1 = 0x31504741; // "AGP1"
  const SH0_COEFF = 0.28209479;
  const HEADER_SIZE_V1 = 52;
  const HEADER_SIZE_V2 = 60;

  // Cached orientation basis and orthonormal frames
  const _basisCache = new Map();

  function _getOrientationBasis(numBins) {
    if (_basisCache.has(numBins)) {
      return _basisCache.get(numBins);
    }

    const _C_ANG = 3.883222077450933;

    const directions = new Float32Array(numBins * 3);
    const frames = new Float32Array(numBins * 9); // 3x3 column-major per entry

    for (let i = 0; i < numBins; i++) {
      const y = 1.0 - (2.0 * i + 1.0) / numBins;
      const radius = Math.sqrt(Math.max(0.0, 1.0 - y * y));
      const theta = _C_ANG * i;
      const x = Math.cos(theta) * radius;
      const z = Math.sin(theta) * radius;

      const norm = Math.hypot(x, y, z) || 1.0;
      const dx = x / norm;
      const dy = y / norm;
      const dz = z / norm;

      directions[i * 3 + 0] = dx;
      directions[i * 3 + 1] = dy;
      directions[i * 3 + 2] = dz;

      // Frame: e1 = d
      // ref = (0, 0, 1), alt_ref = (0, 1, 0)
      // cross_ref = ref x d = (-dy, dx, 0)
      // cross_alt = alt_ref x d = (dz, 0, -dx)
      let e2x = -dy;
      let e2y = dx;
      let e2z = 0.0;
      let e2_norm = Math.hypot(e2x, e2y, e2z);
      if (e2_norm < 1e-6) {
        e2x = dz;
        e2y = 0.0;
        e2z = -dx;
        e2_norm = Math.hypot(e2x, e2y, e2z);
      }
      e2x /= e2_norm || 1.0;
      e2y /= e2_norm || 1.0;
      e2z /= e2_norm || 1.0;

      // e3 = d x e2
      const e3x = dy * e2z - dz * e2y;
      const e3y = dz * e2x - dx * e2z;
      const e3z = dx * e2y - dy * e2x;

      // Store columns: col0=d, col1=e2, col2=e3
      const base = i * 9;
      frames[base + 0] = dx;
      frames[base + 1] = dy;
      frames[base + 2] = dz;
      frames[base + 3] = e2x;
      frames[base + 4] = e2y;
      frames[base + 5] = e2z;
      frames[base + 6] = e3x;
      frames[base + 7] = e3y;
      frames[base + 8] = e3z;
    }

    const cb = { directions, frames };
    _basisCache.set(numBins, cb);
    return cb;
  }

  function decompressZlibSync(bytes) {
    if (typeof process !== "undefined" && process.versions && process.versions.node) {
      const zlib = require("node:zlib");
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return new Uint8Array(zlib.inflateSync(buf));
    }
    throw new Error("Synchronous zlib decompression in browser requires DecompressionStream or pako.");
  }
  function fseDecompress(blob) {
    if (!blob || blob.byteLength === 0) {
      return new Uint8Array(0);
    }
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== 0x31455346) { // "FSE1" in little endian
      throw new Error("Invalid FSE magic");
    }
    const total = view.getUint32(4, true);
    const freqs = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      freqs[i] = view.getUint16(8 + i * 2, true);
    }
    const origLen = view.getUint32(520, true);
    const stream = [];
    for (let i = 524; i < blob.byteLength; i++) {
      stream.push(blob[i]);
    }
    const cum = new Uint32Array(257);
    for (let i = 0; i < 256; i++) {
      cum[i + 1] = cum[i] + freqs[i];
    }
    const slotToSym = new Uint8Array(total);
    for (let s = 0; s < 256; s++) {
      if (freqs[s] > 0) {
        for (let j = cum[s]; j < cum[s + 1]; j++) {
          slotToSym[j] = s;
        }
      }
    }
    let state = ((stream.pop() << 24) | (stream.pop() << 16) | (stream.pop() << 8) | stream.pop()) >>> 0;
    const L = 65536;
    const decoded = new Uint8Array(origLen);
    for (let idx = 0; idx < origLen; idx++) {
      const slot = state % total;
      const s = slotToSym[slot];
      decoded[idx] = s;
      const f = freqs[s];
      const c = cum[s];
      state = (f * Math.floor(state / total) + (slot - c)) >>> 0;
      while (state < L && stream.length > 0) {
        state = ((state << 8) | stream.pop()) >>> 0;
      }
    }
    return decoded;
  }


  function unpackColumnar(rawCols, numGaussians, fields) {
    const totalRecordBytes = fields.reduce((acc, f) => acc + f.size, 0);
    const body = new Uint8Array(numGaussians * totalRecordBytes);
    let colOffset = 0;

    for (const f of fields) {
      const colSize = numGaussians * f.size;
      const col = rawCols.subarray(colOffset, colOffset + colSize);
      for (let i = 0; i < numGaussians; i++) {
        const destOffset = i * totalRecordBytes + f.offset;
        for (let b = 0; b < f.size; b++) {
          body[destOffset + b] = col[i * f.size + b];
        }
      }
      colOffset += colSize;
    }
    return body;
  }

  class AGCDecoder {
    static decompressProgressiveHeader(bufferOrArray) {
      const uint8 = bufferOrArray instanceof Uint8Array
        ? bufferOrArray
        : new Uint8Array(bufferOrArray);
      if (uint8.byteLength < 58) {
        throw new Error("Failed to load AGC archive");
      }
      const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
      const magic = view.getUint32(0, true);
      if (magic !== MAGIC_PKGS && magic !== MAGIC_AGP1) {
        throw new Error("Failed to load AGC archive");
      }
      const version = view.getUint8(4);
      const tierId = view.getUint8(5);
      const dirBins = view.getUint16(6, true);
      const numChunks = view.getUint8(9);
      const totalGaussians = view.getUint32(10, true);
      const bMinX = view.getFloat32(14, true);
      const bMinY = view.getFloat32(18, true);
      const bMinZ = view.getFloat32(22, true);
      const bMaxX = view.getFloat32(26, true);
      const bMaxY = view.getFloat32(30, true);
      const bMaxZ = view.getFloat32(34, true);
      const logScaleMin = view.getFloat32(38, true);
      const logScaleMax = view.getFloat32(42, true);
      const logTransMin = view.getFloat32(46, true);
      const logTransMax = view.getFloat32(50, true);
      const delta = view.getFloat32(54, true);

      const toc = [];
      if (uint8.byteLength >= 58 + numChunks * 8) {
        for (let i = 0; i < numChunks; i++) {
          const cnt = view.getUint32(58 + i * 8, true);
          const sz = view.getUint32(58 + i * 8 + 4, true);
          toc.push({ count: cnt, byteLength: sz });
        }
      }

      const header = {
        tierId,
        dirBins,
        numChunks,
        totalGaussians,
        bboxMin: [bMinX, bMinY, bMinZ],
        bboxMax: [bMaxX, bMaxY, bMaxZ],
        logScaleMin,
        logScaleMax,
        logTransMin,
        logTransMax,
        delta,
      };

      return new ProgressiveStream(header, toc);
    }

    static decompress(bufferOrArray) {
      const uint8 = bufferOrArray instanceof Uint8Array
        ? bufferOrArray
        : new Uint8Array(bufferOrArray);

      if (uint8.byteLength < 4) {
        throw new Error("Truncated .kgs buffer");
      }

      const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);
      const magic = view.getUint32(0, true);

      if (magic === MAGIC_KGZ1 || magic === MAGIC_KGZ2 || magic === MAGIC_AGZ1 || magic === MAGIC_AGZ2) {
        return AGCDecoder._decompressKGZ(uint8, view, magic);
      }
      if (magic === MAGIC_KGX1 || magic === MAGIC_KGX2 || magic === MAGIC_AGX1 || magic === MAGIC_AGX2) {
        return AGCDecoder._decompressAGX(uint8, view, magic);
      }
      if (magic === MAGIC_V1 || magic === MAGIC_AGC1) {
        const cloud = AGCDecoder._decompressV1(uint8, view);
        AGCDecoder._decodeSHTrailerIfPresent(uint8, view, cloud, true);
        return cloud;
      }
      if (magic === MAGIC_V2 || magic === MAGIC_AGC2) {
        const cloud = AGCDecoder._decompressV2(uint8, view);
        AGCDecoder._decodeSHTrailerIfPresent(uint8, view, cloud, false);
        return cloud;
      }
      throw new Error(`Invalid AGC/KGS magic: 0x${magic.toString(16)}`);
    }
    static _decodeSHTrailerIfPresent(uint8, view, cloud, isV1) {
      const numGaussians = view.getUint32(5, true);
      const dirIndexBytes = view.getUint8(12);
      let geomEnd;
      if (isV1) {
        const recSize = dirIndexBytes === 1 ? 12 : 13;
        geomEnd = HEADER_SIZE_V1 + numGaussians * recSize;
      } else {
        const transverseMode = view.getUint8(13);
        let recSize = (dirIndexBytes === 1 ? 12 : 13) + 1;
        if (transverseMode === 1) recSize += 1;
        else if (transverseMode === 2) recSize += 2;
        geomEnd = HEADER_SIZE_V2 + numGaussians * recSize;
      }
      if (uint8.byteLength < geomEnd + 18) {
        return;
      }
      const kshOffset = geomEnd;
      const kshView = new DataView(uint8.buffer, uint8.byteOffset + kshOffset, uint8.byteLength - kshOffset);
      const kshMagic = kshView.getUint32(0, true);
      if (kshMagic !== 0x3148534b) { // "KSH1"
        return;
      }
      const degree = kshView.getUint8(5);
      const bitDepth = kshView.getUint8(6);
      const kshNumGaussians = kshView.getUint32(8, true);
      const numCoeffs = kshView.getUint16(12, true);
      const bound = kshView.getFloat32(14, true);

      const decompressed = decompressZlibSync(uint8.subarray(kshOffset + 18));
      const shRest = new Float32Array(kshNumGaussians * numCoeffs);
      if (bitDepth === 8) {
        for (let c = 0; c < numCoeffs; c++) {
          const colStart = c * kshNumGaussians;
          for (let i = 0; i < kshNumGaussians; i++) {
            const val = decompressed[colStart + i];
            shRest[i * numCoeffs + c] = (val / 255.0) * (2.0 * bound) - bound;
          }
        }
      } else if (bitDepth === 4) {
        const packedWidth = Math.floor((numCoeffs + 1) / 2);
        for (let i = 0; i < kshNumGaussians; i++) {
          const rowStart = i * packedWidth;
          for (let c = 0; c < numCoeffs; c++) {
            const byteVal = decompressed[rowStart + Math.floor(c / 2)];
            const nibble = (c % 2 === 0) ? (byteVal & 0x0F) : ((byteVal >> 4) & 0x0F);
            shRest[i * numCoeffs + c] = (nibble / 15.0) * (2.0 * bound) - bound;
          }
        }
      }
      cloud.shRest = shRest;
      cloud.shDegree = degree;
    }

    static _decompressKGZ(uint8, view, magic) {
      const isV1 = (magic === MAGIC_KGZ1 || magic === MAGIC_AGZ1);
      const isAGC = (magic === MAGIC_AGZ1 || magic === MAGIC_AGZ2);
      const headerSize = isV1 ? HEADER_SIZE_V1 : HEADER_SIZE_V2;
      const rawCols = decompressZlibSync(uint8.subarray(headerSize));

      const numGaussians = view.getUint32(5, true);
      const dirBins = view.getUint16(9, true);
      const dirIndexBytes = view.getUint8(12);

      let fields;
      if (isV1) {
        fields = [
          { name: "x", size: 2, offset: 0 },
          { name: "y", size: 2, offset: 2 },
          { name: "z", size: 2, offset: 4 },
          { name: "dq", size: dirIndexBytes, offset: 6 },
          { name: "sl", size: 1, offset: 6 + dirIndexBytes },
          { name: "a", size: 1, offset: 7 + dirIndexBytes },
          { name: "c0", size: 1, offset: 8 + dirIndexBytes },
          { name: "c1", size: 1, offset: 9 + dirIndexBytes },
          { name: "c2", size: 1, offset: 10 + dirIndexBytes },
        ];
      } else {
        const transverseMode = view.getUint8(13);
        fields = [
          { name: "x", size: 2, offset: 0 },
          { name: "y", size: 2, offset: 2 },
          { name: "z", size: 2, offset: 4 },
          { name: "dq", size: dirIndexBytes, offset: 6 },
          { name: "sl", size: 1, offset: 6 + dirIndexBytes },
          { name: "a", size: 1, offset: 7 + dirIndexBytes },
          { name: "c0", size: 1, offset: 8 + dirIndexBytes },
          { name: "c1", size: 1, offset: 9 + dirIndexBytes },
          { name: "c2", size: 1, offset: 10 + dirIndexBytes },
          { name: "tm", size: 1, offset: 11 + dirIndexBytes },
        ];
        if (transverseMode === 2) {
          fields.push({ name: "tx", size: 1, offset: 12 + dirIndexBytes });
          fields.push({ name: "r", size: 1, offset: 13 + dirIndexBytes });
        } else {
          fields.push({ name: "r", size: 1, offset: 12 + dirIndexBytes });
        }
      }

      const body = unpackColumnar(rawCols, numGaussians, fields);
      const rawData = new Uint8Array(headerSize + body.byteLength);
      rawData.set(uint8.subarray(0, headerSize), 0);
      rawData.set(body, headerSize);
      // Rewrite magic to KGS1 or KGS2
      const rawView = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);
      const targetMagic = isAGC
        ? (isV1 ? MAGIC_AGC1 : MAGIC_AGC2)
        : (isV1 ? MAGIC_V1 : MAGIC_V2);
      rawView.setUint32(0, targetMagic, true);
      return isV1
        ? AGCDecoder._decompressV1(rawData, rawView)
        : AGCDecoder._decompressV2(rawData, rawView);
    }
    static _decompressAGX(uint8, view, magic) {
      const isV1 = (magic === MAGIC_KGX1 || magic === MAGIC_AGX1);
      const isAGC = (magic === MAGIC_AGX1 || magic === MAGIC_AGX2);
      const headerSize = isV1 ? HEADER_SIZE_V1 : HEADER_SIZE_V2;
      const rawCols = fseDecompress(uint8.subarray(headerSize));

      const numGaussians = view.getUint32(5, true);
      const dirBins = view.getUint16(9, true);
      const dirIndexBytes = view.getUint8(12);

      let fields;
      if (isV1) {
        fields = [
          { name: "x", size: 2, offset: 0 },
          { name: "y", size: 2, offset: 2 },
          { name: "z", size: 2, offset: 4 },
          { name: "dq", size: dirIndexBytes, offset: 6 },
          { name: "sl", size: 1, offset: 6 + dirIndexBytes },
          { name: "a", size: 1, offset: 7 + dirIndexBytes },
          { name: "c0", size: 1, offset: 8 + dirIndexBytes },
          { name: "c1", size: 1, offset: 9 + dirIndexBytes },
          { name: "c2", size: 1, offset: 10 + dirIndexBytes },
        ];
      } else {
        const transverseMode = view.getUint8(13);
        fields = [
          { name: "x", size: 2, offset: 0 },
          { name: "y", size: 2, offset: 2 },
          { name: "z", size: 2, offset: 4 },
          { name: "dq", size: dirIndexBytes, offset: 6 },
          { name: "sl", size: 1, offset: 6 + dirIndexBytes },
          { name: "a", size: 1, offset: 7 + dirIndexBytes },
          { name: "c0", size: 1, offset: 8 + dirIndexBytes },
          { name: "c1", size: 1, offset: 9 + dirIndexBytes },
          { name: "c2", size: 1, offset: 10 + dirIndexBytes },
          { name: "tm", size: 1, offset: 11 + dirIndexBytes },
        ];
        if (transverseMode === 2) {
          fields.push({ name: "tx", size: 1, offset: 12 + dirIndexBytes });
          fields.push({ name: "r", size: 1, offset: 13 + dirIndexBytes });
        } else {
          fields.push({ name: "r", size: 1, offset: 12 + dirIndexBytes });
        }
      }

      const body = unpackColumnar(rawCols, numGaussians, fields);
      const rawData = new Uint8Array(headerSize + body.byteLength);
      rawData.set(uint8.subarray(0, headerSize), 0);
      rawData.set(body, headerSize);
      const rawView = new DataView(rawData.buffer, rawData.byteOffset, rawData.byteLength);
      const targetMagic = isAGC
        ? (isV1 ? MAGIC_AGC1 : MAGIC_AGC2)
        : (isV1 ? MAGIC_V1 : MAGIC_V2);
      rawView.setUint32(0, targetMagic, true);
      return isV1
        ? AGCDecoder._decompressV1(rawData, rawView)
        : AGCDecoder._decompressV2(rawData, rawView);
    }

    static _decompressV1(uint8, view) {
      const numGaussians = view.getUint32(5, true);
      const dirBins = view.getUint16(9, true);
      const dirIndexBytes = view.getUint8(12);

      const bboxMinX = view.getFloat32(13, true);
      const bboxMinY = view.getFloat32(17, true);
      const bboxMinZ = view.getFloat32(21, true);
      const bboxMaxX = view.getFloat32(25, true);
      const bboxMaxY = view.getFloat32(29, true);
      const bboxMaxZ = view.getFloat32(33, true);
      const delta = view.getFloat32(37, true);
      const logScaleMin = view.getFloat32(41, true);
      const logScaleMax = view.getFloat32(45, true);

      const extX = Math.max(bboxMaxX - bboxMinX, 1e-6);
      const extY = Math.max(bboxMaxY - bboxMinY, 1e-6);
      const extZ = Math.max(bboxMaxZ - bboxMinZ, 1e-6);
      const logSpan = Math.max(logScaleMax - logScaleMin, 1e-8);

      const cb = _getOrientationBasis(dirBins);

      const positions = new Float32Array(numGaussians * 3);
      const scales = new Float32Array(numGaussians * 3);
      const quaternions = new Float32Array(numGaussians * 4);
      const opacities = new Float32Array(numGaussians);
      const colors = new Float32Array(numGaussians * 3);
      const covariances = new Float32Array(numGaussians * 6); // upper triangle

      const recSize = dirIndexBytes === 1 ? 12 : 13;
      let offset = HEADER_SIZE_V1;

      for (let i = 0; i < numGaussians; i++) {
        const x_q = view.getUint16(offset + 0, true);
        const y_q = view.getUint16(offset + 2, true);
        const z_q = view.getUint16(offset + 4, true);

        positions[i * 3 + 0] = bboxMinX + (x_q / 65535.0) * extX;
        positions[i * 3 + 1] = bboxMinY + (y_q / 65535.0) * extY;
        positions[i * 3 + 2] = bboxMinZ + (z_q / 65535.0) * extZ;

        let dirIdx = 0;
        let cur = offset + 6;
        if (dirIndexBytes === 1) {
          dirIdx = view.getUint8(cur);
          cur += 1;
        } else {
          dirIdx = view.getUint16(cur, true);
          cur += 2;
        }

        const slq = view.getUint8(cur++);
        const aq = view.getUint8(cur++);
        const c0 = view.getUint8(cur++);
        const c1 = view.getUint8(cur++);
        const c2 = view.getUint8(cur++);

        const sLong = Math.exp(logScaleMin + (slq / 255.0) * logSpan);
        scales[i * 3 + 0] = sLong;
        scales[i * 3 + 1] = delta;
        scales[i * 3 + 2] = delta;

        const alpha = aq / 255.0;
        opacities[i] = Math.log(Math.max(1e-6, Math.min(1.0 - 1e-6, alpha)) / (1.0 - Math.max(1e-6, Math.min(1.0 - 1e-6, alpha))));

        colors[i * 3 + 0] = (c0 / 255.0 - 0.5) / SH0_COEFF;
        colors[i * 3 + 1] = (c1 / 255.0 - 0.5) / SH0_COEFF;
        colors[i * 3 + 2] = (c2 / 255.0 - 0.5) / SH0_COEFF;

        // Orientation frame -> Quaternion (xyzw)
        const fBase = dirIdx * 9;
        const r00 = cb.frames[fBase + 0], r10 = cb.frames[fBase + 1], r20 = cb.frames[fBase + 2];
        const r01 = cb.frames[fBase + 3], r11 = cb.frames[fBase + 4], r21 = cb.frames[fBase + 5];
        const r02 = cb.frames[fBase + 6], r12 = cb.frames[fBase + 7], r22 = cb.frames[fBase + 8];

        AGCDecoder._matrixToQuat(r00, r01, r02, r10, r11, r12, r20, r21, r22, quaternions, i * 4);
        AGCDecoder._computeCovarianceUpper(
          r00, r01, r02, r10, r11, r12, r20, r21, r22,
          sLong, delta, delta,
          covariances, i * 6
        );

        offset += recSize;
      }

      return {
        numGaussians,
        version: 1,
        positions,
        scales,
        quaternions,
        opacities,
        colors,
        covariances,
      };
    }

    static _decompressV2(uint8, view) {
      const numGaussians = view.getUint32(5, true);
      const dirBins = view.getUint16(9, true);
      const dirIndexBytes = view.getUint8(12);
      const transverseMode = view.getUint8(13);

      const bboxMinX = view.getFloat32(16, true);
      const bboxMinY = view.getFloat32(20, true);
      const bboxMinZ = view.getFloat32(24, true);
      const bboxMaxX = view.getFloat32(28, true);
      const bboxMaxY = view.getFloat32(32, true);
      const bboxMaxZ = view.getFloat32(36, true);
      const logScaleMin = view.getFloat32(40, true);
      const logScaleMax = view.getFloat32(44, true);
      const logTransMin = view.getFloat32(48, true);
      const logTransMax = view.getFloat32(52, true);
      const extX = Math.max(bboxMaxX - bboxMinX, 1e-6);
      const extY = Math.max(bboxMaxY - bboxMinY, 1e-6);
      const extZ = Math.max(bboxMaxZ - bboxMinZ, 1e-6);
      const logSSpan = Math.max(logScaleMax - logScaleMin, 1e-8);
      const logTSpan = Math.max(logTransMax - logTransMin, 1e-8);

      const cb = _getOrientationBasis(dirBins);

      const positions = new Float32Array(numGaussians * 3);
      const scales = new Float32Array(numGaussians * 3);
      const quaternions = new Float32Array(numGaussians * 4);
      const opacities = new Float32Array(numGaussians);
      const colors = new Float32Array(numGaussians * 3);
      const covariances = new Float32Array(numGaussians * 6);

      const isAniso = transverseMode === 2;
      const baseRec = dirIndexBytes === 1 ? 12 : 13;
      const recSize = baseRec + (isAniso ? 3 : 2);
      let offset = HEADER_SIZE_V2;

      for (let i = 0; i < numGaussians; i++) {
        const x_q = view.getUint16(offset + 0, true);
        const y_q = view.getUint16(offset + 2, true);
        const z_q = view.getUint16(offset + 4, true);

        positions[i * 3 + 0] = bboxMinX + (x_q / 65535.0) * extX;
        positions[i * 3 + 1] = bboxMinY + (y_q / 65535.0) * extY;
        positions[i * 3 + 2] = bboxMinZ + (z_q / 65535.0) * extZ;

        let dirIdx = 0;
        let cur = offset + 6;
        if (dirIndexBytes === 1) {
          dirIdx = view.getUint8(cur);
          cur += 1;
        } else {
          dirIdx = view.getUint16(cur, true);
          cur += 2;
        }

        const slq = view.getUint8(cur++);
        const aq = view.getUint8(cur++);
        const c0 = view.getUint8(cur++);
        const c1 = view.getUint8(cur++);
        const c2 = view.getUint8(cur++);
        const tmq = view.getUint8(cur++);
        const tmx = isAniso ? view.getUint8(cur++) : tmq;
        const rq = view.getUint8(cur++);

        const sLong = Math.exp(logScaleMin + (slq / 255.0) * logSSpan);
        const tMin = Math.exp(logTransMin + (tmq / 255.0) * logTSpan);
        const tMax = Math.exp(logTransMin + (tmx / 255.0) * logTSpan);

        scales[i * 3 + 0] = sLong;
        scales[i * 3 + 1] = tMin;
        scales[i * 3 + 2] = tMax;

        const alpha = aq / 255.0;
        opacities[i] = Math.log(Math.max(1e-6, Math.min(1.0 - 1e-6, alpha)) / (1.0 - Math.max(1e-6, Math.min(1.0 - 1e-6, alpha))));

        colors[i * 3 + 0] = (c0 / 255.0 - 0.5) / SH0_COEFF;
        colors[i * 3 + 1] = (c1 / 255.0 - 0.5) / SH0_COEFF;
        colors[i * 3 + 2] = (c2 / 255.0 - 0.5) / SH0_COEFF;

        // Orientation frame + roll
        const fBase = dirIdx * 9;
        const e1x = cb.frames[fBase + 0], e1y = cb.frames[fBase + 1], e1z = cb.frames[fBase + 2];
        const e2x = cb.frames[fBase + 3], e2y = cb.frames[fBase + 4], e2z = cb.frames[fBase + 5];
        const e3x = cb.frames[fBase + 6], e3y = cb.frames[fBase + 7], e3z = cb.frames[fBase + 8];

        const roll = (rq / 255.0) * (2.0 * Math.PI) - Math.PI;
        const cosR = Math.cos(roll);
        const sinR = Math.sin(roll);

        // e2_roll = cos(roll)*e2 + sin(roll)*e3
        const u2x = cosR * e2x + sinR * e3x;
        const u2y = cosR * e2y + sinR * e3y;
        const u2z = cosR * e2z + sinR * e3z;

        // e3_roll = -sin(roll)*e2 + cos(roll)*e3
        const u3x = -sinR * e2x + cosR * e3x;
        const u3y = -sinR * e2y + cosR * e3y;
        const u3z = -sinR * e2z + cosR * e3z;

        // Rotation matrix columns are [e1, u2, u3]
        const r00 = e1x, r10 = e1y, r20 = e1z;
        const r01 = u2x, r11 = u2y, r21 = u2z;
        const r02 = u3x, r12 = u3y, r22 = u3z;

        AGCDecoder._matrixToQuat(r00, r01, r02, r10, r11, r12, r20, r21, r22, quaternions, i * 4);
        AGCDecoder._computeCovarianceUpper(
          r00, r01, r02, r10, r11, r12, r20, r21, r22,
          sLong, tMin, tMax,
          covariances, i * 6
        );

        offset += recSize;
      }

      return {
        numGaussians,
        version: 2,
        positions,
        scales,
        quaternions,
        opacities,
        colors,
        covariances,
      };
    }

    static _matrixToQuat(r00, r01, r02, r10, r11, r12, r20, r21, r22, out, outOffset) {
      // Shepperd algorithm matching rotation_to_quaternion
      const tr = r00 + r11 + r22;
      let qx, qy, qz, qw;
      if (tr > 0.0) {
        const s = Math.sqrt(tr + 1.0) * 2.0;
        qw = 0.25 * s;
        qx = (r21 - r12) / s;
        qy = (r02 - r20) / s;
        qz = (r10 - r01) / s;
      } else if (r00 > r11 && r00 > r22) {
        const s = Math.sqrt(1.0 + r00 - r11 - r22) * 2.0;
        qw = (r21 - r12) / s;
        qx = 0.25 * s;
        qy = (r01 + r10) / s;
        qz = (r02 + r20) / s;
      } else if (r11 > r22) {
        const s = Math.sqrt(1.0 + r11 - r00 - r22) * 2.0;
        qw = (r02 - r20) / s;
        qx = (r01 + r10) / s;
        qy = 0.25 * s;
        qz = (r12 + r21) / s;
      } else {
        const s = Math.sqrt(1.0 + r22 - r00 - r11) * 2.0;
        qw = (r10 - r01) / s;
        qx = (r02 + r20) / s;
        qy = (r12 + r21) / s;
        qz = 0.25 * s;
      }
      out[outOffset + 0] = qx;
      out[outOffset + 1] = qy;
      out[outOffset + 2] = qz;
      out[outOffset + 3] = qw;
    }

    static _computeCovarianceUpper(
      r00, r01, r02, r10, r11, r12, r20, r21, r22,
      s0, s1, s2,
      out, outOffset
    ) {
      // Sigma = R * S * S^T * R^T
      const s0sq = s0 * s0;
      const s1sq = s1 * s1;
      const s2sq = s2 * s2;

      // cov00 = r00^2 * s0sq + r01^2 * s1sq + r02^2 * s2sq
      out[outOffset + 0] = r00 * r00 * s0sq + r01 * r01 * s1sq + r02 * r02 * s2sq;
      // cov01
      out[outOffset + 1] = r00 * r10 * s0sq + r01 * r11 * s1sq + r02 * r12 * s2sq;
      // cov02
      out[outOffset + 2] = r00 * r20 * s0sq + r01 * r21 * s1sq + r02 * r22 * s2sq;
      // cov11
      out[outOffset + 3] = r10 * r10 * s0sq + r11 * r11 * s1sq + r12 * r12 * s2sq;
      // cov12
      out[outOffset + 4] = r10 * r20 * s0sq + r11 * r21 * s1sq + r12 * r22 * s2sq;
      // cov22
      out[outOffset + 5] = r20 * r20 * s0sq + r21 * r21 * s1sq + r22 * r22 * s2sq;
    }
  }
  class ProgressiveStream {
    constructor(header, toc) {
      this.header = header;
      this.toc = toc;
      this.accumulatedRecords = [];
      this.accumulatedGaussians = 0;
      this.currentChunkIdx = 0;
      this.cb = _getOrientationBasis(header.dirBins);
    }

    get isComplete() {
      return this.accumulatedGaussians >= this.header.totalGaussians;
    }

    get progress() {
      return this.header.totalGaussians === 0
        ? 0.0
        : Math.min(1.0, this.accumulatedGaussians / this.header.totalGaussians);
    }

    feedChunk(chunkBufferOrArray, count) {
      const u8 = chunkBufferOrArray instanceof Uint8Array
        ? chunkBufferOrArray
        : new Uint8Array(chunkBufferOrArray);
      if (count === undefined && this.currentChunkIdx < this.toc.length) {
        count = this.toc[this.currentChunkIdx].count;
      }
      this.accumulatedRecords.push(u8);
      this.accumulatedGaussians += (count || 0);
      this.currentChunkIdx++;

      return this._decodeAccumulated();
    }

    _decodeAccumulated() {
      const n = this.accumulatedGaussians;
      let totalLen = 0;
      for (const b of this.accumulatedRecords) totalLen += b.byteLength;
      const merged = new Uint8Array(totalLen);
      let off = 0;
      for (const b of this.accumulatedRecords) {
        merged.set(b, off);
        off += b.byteLength;
      }
      const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);

      const positions = new Float32Array(n * 3);
      const scales = new Float32Array(n * 3);
      const quaternions = new Float32Array(n * 4);
      const opacities = new Float32Array(n);
      const colors = new Float32Array(n * 3);
      const covariances = new Float32Array(n * 6);

      const h = this.header;
      const extX = Math.max(h.bboxMax[0] - h.bboxMin[0], 1e-6);
      const extY = Math.max(h.bboxMax[1] - h.bboxMin[1], 1e-6);
      const extZ = Math.max(h.bboxMax[2] - h.bboxMin[2], 1e-6);
      const logSpan = Math.max(h.logScaleMax - h.logScaleMin, 1e-8);
      const logTransSpan = Math.max(h.logTransMax - h.logTransMin, 1e-8);

      const dirIndexBytes = h.dirBins <= 256 ? 1 : 2;
      const isV1 = h.tierId === 0;
      let recSize;
      if (isV1) {
        recSize = dirIndexBytes === 1 ? 12 : 13;
      } else {
        recSize = (dirIndexBytes === 1 ? 12 : 13) + (h.tierId === 1 ? 2 : 3);
      }

      let offset = 0;
      for (let i = 0; i < n; i++) {
        const x_q = view.getUint16(offset + 0, true);
        const y_q = view.getUint16(offset + 2, true);
        const z_q = view.getUint16(offset + 4, true);
        positions[i * 3 + 0] = h.bboxMin[0] + (x_q / 65535.0) * extX;
        positions[i * 3 + 1] = h.bboxMin[1] + (y_q / 65535.0) * extY;
        positions[i * 3 + 2] = h.bboxMin[2] + (z_q / 65535.0) * extZ;

        let dirIdx = 0;
        let cur = offset + 6;
        if (dirIndexBytes === 1) {
          dirIdx = view.getUint8(cur);
          cur += 1;
        } else {
          dirIdx = view.getUint16(cur, true);
          cur += 2;
        }
        const slq = view.getUint8(cur++);
        const aq = view.getUint8(cur++);
        const c0 = view.getUint8(cur++);
        const c1 = view.getUint8(cur++);
        const c2 = view.getUint8(cur++);

        const sLong = Math.exp(h.logScaleMin + (slq / 255.0) * logSpan);
        let sTrans1, sTrans2, roll;
        if (isV1) {
          sTrans1 = h.delta;
          sTrans2 = h.delta;
          roll = 0.0;
        } else {
          const tmq = view.getUint8(cur++);
          sTrans1 = Math.exp(h.logTransMin + (tmq / 255.0) * logTransSpan);
          if (h.tierId === 2) {
            const txq = view.getUint8(cur++);
            sTrans2 = Math.exp(h.logTransMin + (txq / 255.0) * logTransSpan);
          } else {
            sTrans2 = sTrans1;
          }
          const rq = view.getUint8(cur++);
          roll = (rq / 255.0) * (2.0 * Math.PI) - Math.PI;
        }

        scales[i * 3 + 0] = sLong;
        scales[i * 3 + 1] = sTrans1;
        scales[i * 3 + 2] = sTrans2;

        const alpha = aq / 255.0;
        opacities[i] = Math.log(
          Math.max(1e-6, Math.min(1.0 - 1e-6, alpha)) /
          (1.0 - Math.max(1e-6, Math.min(1.0 - 1e-6, alpha)))
        );

        colors[i * 3 + 0] = (c0 / 255.0 - 0.5) / SH0_COEFF;
        colors[i * 3 + 1] = (c1 / 255.0 - 0.5) / SH0_COEFF;
        colors[i * 3 + 2] = (c2 / 255.0 - 0.5) / SH0_COEFF;

        const fBase = dirIdx * 9;
        let r00 = this.cb.frames[fBase + 0], r10 = this.cb.frames[fBase + 1], r20 = this.cb.frames[fBase + 2];
        let r01 = this.cb.frames[fBase + 3], r11 = this.cb.frames[fBase + 4], r21 = this.cb.frames[fBase + 5];
        let r02 = this.cb.frames[fBase + 6], r12 = this.cb.frames[fBase + 7], r22 = this.cb.frames[fBase + 8];

        if (roll !== 0.0) {
          const cr = Math.cos(roll), sr = Math.sin(roll);
          const e2x = r01, e2y = r11, e2z = r21;
          const e3x = r02, e3y = r12, e3z = r22;
          r01 = cr * e2x + sr * e3x;
          r11 = cr * e2y + sr * e3y;
          r21 = cr * e2z + sr * e3z;
          r02 = -sr * e2x + cr * e3x;
          r12 = -sr * e2y + cr * e3y;
          r22 = -sr * e2z + cr * e3z;
        }

        AGCDecoder._matrixToQuat(r00, r01, r02, r10, r11, r12, r20, r21, r22, quaternions, i * 4);
        AGCDecoder._computeCovarianceUpper(
          r00, r01, r02, r10, r11, r12, r20, r21, r22,
          sLong, sTrans1, sTrans2,
          covariances, i * 6
        );

        offset += recSize;
      }

      return {
        numGaussians: n,
        positions,
        scales,
        quaternions,
        opacities,
        colors,
        covariances,
      };
    }
  }

  return AGCDecoder;
});

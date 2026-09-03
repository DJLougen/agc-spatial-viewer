importScripts("agc_decoder.js");

self.onmessage = function (e) {
  try {
    const raw = e.data && e.data.buffer ? e.data.buffer : e.data;
    const cloud = AGCDecoder.decompress(raw);
    const transfers = [];
    const keys = ["positions", "scales", "quaternions", "opacities", "colors", "covariances", "shRest"];
    for (let i = 0; i < keys.length; i++) {
      const arr = cloud[keys[i]];
      if (arr && arr.buffer instanceof ArrayBuffer) {
        transfers.push(arr.buffer);
      }
    }
    self.postMessage(cloud, transfers);
  } catch (err) {
    self.postMessage({ error: err.message || "Failed to load AGC archive" });
  }
};

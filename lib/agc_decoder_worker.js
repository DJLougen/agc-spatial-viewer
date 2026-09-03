importScripts("agc_decoder.js");

self.onmessage = function (e) {
  try {
    const raw = e.data && e.data.buffer ? e.data.buffer : e.data;
    const cloud = AGCDecoder.decompress(raw);
    self.postMessage(cloud);
  } catch (err) {
    self.postMessage({ error: err.message || "Failed to load AGC archive" });
  }
};

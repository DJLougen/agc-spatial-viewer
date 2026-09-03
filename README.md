# Adaptive Geometric Compression (AGC) — Vision Pro WebXR Spatial Stream

Interactive 3D Gaussian Splat viewer running in Apple Vision Pro Safari via WebXR.

Streams compact `.agc` geometry archives (~12–16 bytes per Gaussian) and decompresses them in real time in JavaScript/WebGL.

## Live Demo

- **Vision Pro Safari & Web**: [https://djlougen.github.io/agc-spatial-viewer/](https://djlougen.github.io/agc-spatial-viewer/)

### Vision Pro Controls
- **Pinch to Orbit**: Single-hand pinch and drag to rotate around the scene
- **Two-Finger Zoom**: Two-hand pinch and spread to zoom in and out
- **Enter Immersive**: Tap "Enter Immersive" in Safari to transition into fully immersive stereoscopic spatial mode via WebXR (`immersive-vr` session with `local-floor`)

## Features

- **Pinch-first interaction**: Native interaction model tuned for visionOS Safari
- **Instant client-side decompression**: Decompresses binary `.agc` streams via Web Worker into typed arrays
- **Instanced splat rendering**: GPU-accelerated splat rasterizer in Three.js
- **Z-up coordinate framing**: Automatic bounding box framing and camera placement

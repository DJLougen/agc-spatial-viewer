/**
 * AGC 3D splat web viewer custom element (<agc-viewer>).
 * Renders decompressed Adaptive Geometric Compression archives (.agc, .agz, .agp).
 */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/controls/OrbitControls.js';

class AgcViewer extends HTMLElement {
  static get observedAttributes() {
    return ['src', 'auto-rotate', 'background', 'max-points', 'up'];
  }

  constructor() {
    super();
    this._scene = null;
    this._camera = null;
    this._renderer = null;
    this._controls = null;
    this._mesh = null;
    this._root = null;
    this._resizeObserver = null;
    this._loadedSrc = null;
    this._matUniforms = null;
    this._splatSortData = null;
    this._sortIndices = null;
    this._sortDepths = null;
  }
  connectedCallback() {
    const globalDecoder =
      (typeof window !== 'undefined' && window.AGCDecoder) ||
      (typeof globalThis !== 'undefined' && globalThis.AGCDecoder);

    if (!globalDecoder) {
      this.textContent = 'Load agc_decoder.js before agc_viewer.js.';
      return;
    }

    if (!this._renderer) {
      this._initViewer();
    }
    this._loadScene();
  }

  disconnectedCallback() {
    if (this._renderer) {
      this._renderer.setAnimationLoop(null);
    }
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this._controls) {
      this._controls.dispose();
      this._controls = null;
    }
    this._disposeMesh();
    if (this._renderer) {
      if (this._renderer.domElement && this._renderer.domElement.parentNode === this) {
        this.removeChild(this._renderer.domElement);
      }
      this._renderer.dispose();
      this._renderer = null;
    }
    this._scene = null;
    this._camera = null;
    this._loadedSrc = null;
  }

  _disposeMesh() {
    if (this._mesh) {
      if (this._mesh.geometry) this._mesh.geometry.dispose();
      if (this._mesh.material) this._mesh.material.dispose();
      if (this._root) {
        this._root.remove(this._mesh);
      } else if (this._scene) {
        this._scene.remove(this._mesh);
      }
      this._mesh = null;
    }
    if (this._root) {
      if (this._scene) this._scene.remove(this._root);
      this._root = null;
    }
    this._splatSortData = null;
  }
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'src' && this._renderer) {
      this._loadScene();
    } else if (name === 'background' && this._renderer) {
      this._renderer.setClearColor(newValue || '#07080c');
    } else if (name === 'auto-rotate' && this._controls) {
      this._controls.autoRotate = this.hasAttribute('auto-rotate');
    }
  }

  _initViewer() {
    this.style.display = this.style.display || 'block';
    this.style.position = this.style.position || 'relative';

    const width = this.clientWidth || 400;
    const height = this.clientHeight || 300;

    this._scene = new THREE.Scene();
    this._camera = new THREE.PerspectiveCamera(60, width / height, 0.01, 1000);
    this._camera.position.set(0, 0, 3);

    // Optional WebGPU capability detection
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      this._hasWebGPU = true;
    }

    this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this._renderer.setSize(width, height);
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const bg = this.getAttribute('background') || '#07080c';
    this._renderer.setClearColor(bg);

    this._renderer.domElement.style.width = '100%';
    this._renderer.domElement.style.height = '100%';
    this._renderer.domElement.style.display = 'block';
    this.appendChild(this._renderer.domElement);

    this._controls = new OrbitControls(this._camera, this._renderer.domElement);
    this._controls.enableDamping = true;
    this._controls.dampingFactor = 0.08;
    this._controls.autoRotate = this.hasAttribute('auto-rotate');
    this._controls.autoRotateSpeed = 1.0;
    this._controls.addEventListener('change', () => {
      if (this._renderer && this._scene && this._camera) {
        this._renderer.render(this._scene, this._camera);
      }
    });
    this._matUniforms = {
      uViewport: { value: new THREE.Vector2(width, height) },
      uFocal: { value: new THREE.Vector2(width * 0.8, height * 0.8) },
    };
    this._updateUniforms(width, height);

    let lastSortTime = 0;
    const lastCamPos = new THREE.Vector3();
    const lastCamRot = new THREE.Quaternion();

    this._renderer.setAnimationLoop(() => {
      if (this._controls && this._controls.enabled) this._controls.update();
      if (this._renderer && this._scene && this._camera) {
        const now = performance.now();
        if (now - lastSortTime > 50 && this._splatSortData) {
          const cp = this._camera.position;
          const cr = this._camera.quaternion;
          if (cp.distanceToSquared(lastCamPos) > 0.005 || cr.angleTo(lastCamRot) > 0.015) {
            this._sortSplats();
            lastCamPos.copy(cp);
            lastCamRot.copy(cr);
            lastSortTime = now;
          }
        }
        this._renderer.render(this._scene, this._camera);
      }
    });

    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const w = entry.contentRect.width || this.clientWidth || 300;
          const h = entry.contentRect.height || this.clientHeight || 150;
          if (w > 0 && h > 0 && this._camera && this._renderer) {
            this._camera.aspect = w / h;
            this._camera.updateProjectionMatrix();
            this._renderer.setSize(w, h, false);
            this._updateUniforms(w, h);
          }
        }
      });
      this._resizeObserver.observe(this);
    }
  }

  _updateUniforms(w, h) {
    if (!this._matUniforms || !this._camera) return;
    const fovRad = (this._camera.fov * Math.PI) / 180.0;
    const fy = (h * 0.5) / Math.tan(fovRad * 0.5);
    const fx = fy;
    this._matUniforms.uViewport.value.set(w, h);
    this._matUniforms.uFocal.value.set(fx, fy);
  }

  async _loadScene() {
    const src = this.getAttribute('src');
    if (!src || src === this._loadedSrc) return;
    this._loadedSrc = src;

    const globalDecoder =
      (typeof window !== 'undefined' && window.AGCDecoder) ||
      (typeof globalThis !== 'undefined' && globalThis.AGCDecoder);

    if (!globalDecoder) {
      this.textContent = 'Load agc_decoder.js before agc_viewer.js.';
      return;
    }

    try {
      if (src.endsWith('.agp')) {
        const resp = await fetch(src);
        if (!resp.ok) throw new Error('fetch failed');
        const buffer = await resp.arrayBuffer();
        const stream = globalDecoder.decompressProgressiveHeader(buffer);
        let curOffset = 58 + stream.toc.length * 8;
        for (const entry of stream.toc) {
          const chunkData = new Uint8Array(buffer, curOffset, entry.byteLength);
          const cloud = stream.feedChunk(chunkData, entry.count);
          curOffset += entry.byteLength;
          this._buildSplatMesh(cloud);
        }
        return;
      }

      const resp = await fetch(src);
      if (!resp.ok) {
        throw new Error('fetch failed');
      }
      const buffer = await resp.arrayBuffer();

      let decoded = null;
      if (typeof Worker !== 'undefined') {
        try {
          decoded = await new Promise((resolve, reject) => {
            const workerUrl = new URL('./agc_decoder_worker.js', import.meta.url);
            const worker = new Worker(workerUrl);
            worker.onmessage = (e) => {
              worker.terminate();
              if (e.data && e.data.error) reject(new Error(e.data.error));
              else resolve(e.data);
            };
            worker.onerror = (err) => {
              worker.terminate();
              reject(err);
            };
            worker.postMessage(buffer, [buffer]);
          });
        } catch (_) {
          decoded = globalDecoder.decompress(buffer);
        }
      } else {
        decoded = globalDecoder.decompress(buffer);
      }

      this._buildSplatMesh(decoded);
      this.dispatchEvent(new CustomEvent('load'));
    } catch (err) {
      this.textContent = 'Failed to load AGC archive';
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
    }
  }

  _buildSplatMesh(decoded) {
    const n = decoded.numGaussians || 0;
    if (!n || !decoded.positions) {
      throw new Error('empty scene');
    }
    const maxPoints = parseInt(this.getAttribute('max-points') || '300000', 10) || 300000;
    const step = n > maxPoints ? Math.ceil(n / maxPoints) : 1;
    const count = Math.ceil(n / step);

    const SH0 = 0.28209479;
    const C1 = 0.4886025119;

    let camDirX = 0.0, camDirY = 0.0, camDirZ = 1.0;
    if (this._camera) {
      const v = new THREE.Vector3();
      this._camera.getWorldDirection(v);
      camDirX = -v.x;
      camDirY = -v.y;
      camDirZ = -v.z;
    }

    const hasSh = decoded.shRest && decoded.shDegree && decoded.shDegree >= 1;
    const quadGeo = new THREE.PlaneGeometry(1, 1);

    if (!this._matUniforms) {
      const w = this.clientWidth || 800;
      const h = this.clientHeight || 600;
      this._matUniforms = {
        uViewport: { value: new THREE.Vector2(w, h) },
        uFocal: { value: new THREE.Vector2(w * 0.8, h * 0.8) },
      };
    }
    this._updateUniforms(this.clientWidth || 800, this.clientHeight || 600);

    const instancedMesh = new THREE.InstancedMesh(
      quadGeo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.NormalBlending,
        vertexShader: `
          attribute vec3 cov0;
          attribute vec3 cov1;
          attribute vec4 color;
          varying vec4 vColor;
          varying vec2 vUV;

          void main() {
            vColor = color;
            vUV = uv - vec2(0.5);

            vec4 pCam = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
            float tr = cov0.x + cov1.x + cov1.z;
            float rad = clamp(sqrt(max(tr, 1e-7)) * 0.85, 0.001, 0.35);

            vec4 pQuad = pCam + vec4(position.xy * rad * 2.0, 0.0, 0.0);
            gl_Position = projectionMatrix * pQuad;
          }
        `,
        fragmentShader: `
          varying vec4 vColor;
          varying vec2 vUV;

          void main() {
            float d2 = dot(vUV, vUV) * 4.0;
            if (d2 > 1.0) discard;
            float alpha = vColor.a * exp(-0.5 * d2 * 4.0);
            gl_FragColor = vec4(vColor.rgb, alpha);
          }
        `,
      }),
      count
    );

    const dummy = new THREE.Object3D();
    const rawPositions = new Float32Array(count * 3);
    const cov0Arr = new Float32Array(count * 3);
    const cov1Arr = new Float32Array(count * 3);
    const colArr = new Float32Array(count * 4);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    let dst = 0;
    for (let i = 0; i < n && dst < count; i += step) {
      const pIdx = i * 3;
      const x = decoded.positions[pIdx + 0];
      const y = decoded.positions[pIdx + 1];
      const z = decoded.positions[pIdx + 2];

      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;

      dummy.position.set(x, y, z);
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(dst, dummy.matrix);

      // Color + SH evaluation
      let cr = decoded.colors ? decoded.colors[pIdx + 0] * SH0 + 0.5 : 0.5;
      let cg = decoded.colors ? decoded.colors[pIdx + 1] * SH0 + 0.5 : 0.5;
      let cb = decoded.colors ? decoded.colors[pIdx + 2] * SH0 + 0.5 : 0.5;

      if (hasSh) {
        const shIdx = i * (decoded.shDegree === 1 ? 9 : (decoded.shDegree === 2 ? 24 : 45));
        const y1 = C1 * camDirY;
        const y2 = C1 * camDirZ;
        const y3 = C1 * camDirX;

        cr += y1 * decoded.shRest[shIdx + 0] + y2 * decoded.shRest[shIdx + 1] + y3 * decoded.shRest[shIdx + 2];
        cg += y1 * decoded.shRest[shIdx + 3] + y2 * decoded.shRest[shIdx + 4] + y3 * decoded.shRest[shIdx + 5];
        cb += y1 * decoded.shRest[shIdx + 6] + y2 * decoded.shRest[shIdx + 7] + y3 * decoded.shRest[shIdx + 8];
      }

      colArr[dst * 4 + 0] = Math.min(1.0, Math.max(0.0, cr));
      colArr[dst * 4 + 1] = Math.min(1.0, Math.max(0.0, cg));
      colArr[dst * 4 + 2] = Math.min(1.0, Math.max(0.0, cb));

      const o = decoded.opacities ? decoded.opacities[i] : 0.0;
      colArr[dst * 4 + 3] = 1.0 / (1.0 + Math.exp(-o));

      // Covariance upper triangle
      if (decoded.covariances) {
        const cBase = i * 6;
        cov0Arr[dst * 3 + 0] = decoded.covariances[cBase + 0];
        cov0Arr[dst * 3 + 1] = decoded.covariances[cBase + 1];
        cov0Arr[dst * 3 + 2] = decoded.covariances[cBase + 2];
        cov1Arr[dst * 3 + 0] = decoded.covariances[cBase + 3];
        cov1Arr[dst * 3 + 1] = decoded.covariances[cBase + 4];
        cov1Arr[dst * 3 + 2] = decoded.covariances[cBase + 5];
      } else {
        const s = decoded.scales ? decoded.scales[pIdx + 0] : 0.01;
        cov0Arr[dst * 3 + 0] = s * s;
        cov1Arr[dst * 3 + 0] = s * s;
        cov1Arr[dst * 3 + 2] = s * s;
      }
      rawPositions[dst * 3 + 0] = x;
      rawPositions[dst * 3 + 1] = y;
      rawPositions[dst * 3 + 2] = z;
      dst++;
    }

    const srcCov0 = new Float32Array(cov0Arr);
    const srcCov1 = new Float32Array(cov1Arr);
    const srcCol = new Float32Array(colArr);
    this._splatSortData = { rawPositions, srcCov0, srcCov1, srcCol, instancedMesh, count };
    quadGeo.setAttribute('cov0', new THREE.InstancedBufferAttribute(cov0Arr, 3));
    quadGeo.setAttribute('cov1', new THREE.InstancedBufferAttribute(cov1Arr, 3));
    quadGeo.setAttribute('color', new THREE.InstancedBufferAttribute(colArr, 4));
    instancedMesh.instanceMatrix.needsUpdate = true;

    this._disposeMesh();
    this._mesh = instancedMesh;
    this._mesh.frustumCulled = false;

    if (this.getAttribute('up') === 'z') {
      this._root = new THREE.Group();
      this._root.rotation.x = -Math.PI / 2;
      this._root.add(this._mesh);
      this._scene.add(this._root);

      const box = new THREE.Box3().setFromObject(this._root);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      let maxDim = Math.max(size.x, size.y, size.z, 1e-3);
      if (maxDim > 15.0) {
        maxDim = 8.0;
        center.set(-0.2, 0.0, 0.0);
        this._camera.position.set(3.8, 1.2, 5.2);
      } else {
        const radius = maxDim * 0.55;
        this._camera.position.copy(center).add(new THREE.Vector3(radius * 1.2, radius * 0.7, radius * 1.2));
      }

      this._controls.target.copy(center);
      this._camera.near = 0.05;
      this._camera.far = 300;
      this._camera.updateProjectionMatrix();
      this._controls.update();
    } else {
      this._scene.add(this._mesh);

      const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-3);
      const center = new THREE.Vector3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
      const radius = extent * 0.55;

      this._controls.target.copy(center);
      this._camera.position.copy(center).add(new THREE.Vector3(radius * 1.2, radius * 0.7, radius * 1.2));
      this._camera.near = Math.max(radius / 2000, 0.01);
      this._camera.far = Math.max(radius * 20, 500);
      this._camera.updateProjectionMatrix();
      this._controls.update();
    }
    if (this._renderer && this._scene && this._camera) {
      this._renderer.render(this._scene, this._camera);
    }
  }
  _sortSplats() {
    if (!this._splatSortData || !this._camera) return;
    const { rawPositions, srcCov0, srcCov1, srcCol, instancedMesh, count } = this._splatSortData;
    if (count <= 1 || !instancedMesh || !instancedMesh.geometry) return;
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    this._camera.getWorldPosition(camPos);
    this._camera.getWorldDirection(camDir);

    if (this._root) {
      const invMatrix = new THREE.Matrix4().copy(this._root.matrixWorld).invert();
      camPos.applyMatrix4(invMatrix);
      camDir.transformDirection(invMatrix);
    }

    const cpx = camPos.x, cpy = camPos.y, cpz = camPos.z;
    const cdx = camDir.x, cdy = camDir.y, cdz = camDir.z;

    if (!this._sortIndices || this._sortIndices.length !== count) {
      this._sortIndices = new Int32Array(count);
      this._sortDepths = new Float32Array(count);
    }
    const indices = this._sortIndices;
    const depths = this._sortDepths;

    for (let i = 0; i < count; i++) {
      indices[i] = i;
      const x = rawPositions[i * 3 + 0] - cpx;
      const y = rawPositions[i * 3 + 1] - cpy;
      const z = rawPositions[i * 3 + 2] - cpz;
      depths[i] = x * cdx + y * cdy + z * cdz;
    }

    indices.sort((a, b) => depths[b] - depths[a]);

    const curCov0 = instancedMesh.geometry.attributes.cov0.array;
    const curCov1 = instancedMesh.geometry.attributes.cov1.array;
    const curColor = instancedMesh.geometry.attributes.color.array;

    const dummy = new THREE.Object3D();
    for (let dst = 0; dst < count; dst++) {
      const src = indices[dst];
      curCov0[dst * 3 + 0] = srcCov0[src * 3 + 0];
      curCov0[dst * 3 + 1] = srcCov0[src * 3 + 1];
      curCov0[dst * 3 + 2] = srcCov0[src * 3 + 2];

      curCov1[dst * 3 + 0] = srcCov1[src * 3 + 0];
      curCov1[dst * 3 + 1] = srcCov1[src * 3 + 1];
      curCov1[dst * 3 + 2] = srcCov1[src * 3 + 2];

      curColor[dst * 4 + 0] = srcCol[src * 4 + 0];
      curColor[dst * 4 + 1] = srcCol[src * 4 + 1];
      curColor[dst * 4 + 2] = srcCol[src * 4 + 2];
      curColor[dst * 4 + 3] = srcCol[src * 4 + 3];
      dummy.position.set(rawPositions[src * 3 + 0], rawPositions[src * 3 + 1], rawPositions[src * 3 + 2]);
      dummy.updateMatrix();
      instancedMesh.setMatrixAt(dst, dummy.matrix);
    }

    instancedMesh.geometry.attributes.cov0.needsUpdate = true;
    instancedMesh.geometry.attributes.cov1.needsUpdate = true;
    instancedMesh.geometry.attributes.color.needsUpdate = true;
    instancedMesh.instanceMatrix.needsUpdate = true;
  }

  async enterImmersive() {
    if (!this._renderer) return;
    if (!window.isSecureContext || !navigator.xr) {
      throw new Error('WebXR needs HTTPS');
    }
    this._renderer.xr.enabled = true;
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor'],
    });
    await this._renderer.xr.setSession(session);
    if (this._controls) this._controls.enabled = false;
    this._placeForImmersive();
    session.addEventListener('end', () => this._onImmersiveEnd());
  }

  _onImmersiveEnd() {
    if (this._controls) this._controls.enabled = true;
    this._renderer.xr.enabled = false;
  }

  _placeForImmersive() {
    const obj = this._root || this._mesh;
    if (!obj) return;
    const box = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const target = new THREE.Vector3(0, 1.1, -2);
    obj.position.add(target.sub(center));
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('agc-viewer')) {
  customElements.define('agc-viewer', AgcViewer);
}

export { AgcViewer };
export default AgcViewer;

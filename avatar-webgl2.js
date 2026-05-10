// WebGL2 Fallback Renderer for Avatar Platform
// CPU-based morph target deformation + WebGL2 rendering
// Compatible with all devices that support WebGL2

class WebGL2AvatarRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
        if (!this.gl) {
            throw new Error('WebGL2 not available');
        }
        this.mesh = null;
        this.program = null;
        this.vao = null;
        this.posBuffer = null;
        this.normBuffer = null;
        this.indexBuffer = null;
        this.morphWeights = new Float32Array(52);
        this.blendshapeNames = [];
        this.morphTargetCount = 0;
        this.camera = {
            eye: [0, 24.0, 10],
            center: [0, 24.0, 0],
            up: [0, 1, 0]
        };
        this.modelBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        this.rotation = 0;
        this.time = 0;
        // Pre-allocated working buffers for morph deformation
        this.workPositions = null;
        this.workNormals = null;
    }

    async loadModel(url) {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const glb = this.parseGLB(new Uint8Array(buffer));
        this.mesh = this.extractMesh(glb);
        this.morphTargetCount = this.mesh.morphTargets.length;
        console.log(`[webgl2] Model loaded: ${this.mesh.vertexCount} vertices, ${this.morphTargetCount} morph targets, ${this.mesh.indices.length} indices`);

        // Pre-allocate working buffers
        this.workPositions = new Float32Array(this.mesh.vertexCount * 3);
        this.workNormals = new Float32Array(this.mesh.vertexCount * 3);

        this.setupGL();
        this.centerCamera();
    }

    parseGLB(data) {
        const header = new DataView(data.buffer, data.byteOffset, 12);
        const magic = header.getUint32(0, true);
        if (magic !== 0x46546C67) throw new Error('Not a GLB file');
        const version = header.getUint32(4, true);
        const length = header.getUint32(8, true);

        let offset = 12;
        let jsonChunk = null;
        let binChunk = null;

        while (offset < length) {
            const chunkHeader = new DataView(data.buffer, data.byteOffset + offset, 8);
            const chunkLength = chunkHeader.getUint32(0, true);
            const chunkType = chunkHeader.getUint32(4, true);
            const chunkData = data.slice(offset + 8, offset + 8 + chunkLength);

            if (chunkType === 0x4E4F534A) {
                jsonChunk = JSON.parse(new TextDecoder().decode(chunkData));
            } else if (chunkType === 0x004E4942) {
                binChunk = chunkData;
            }
            offset += 8 + chunkLength;
        }

        return { json: jsonChunk, bin: binChunk };
    }

    extractMesh(glb) {
        const json = glb.json;
        const bin = glb.bin;

        // Find ALL primitives with morph targets and pick the one with highest max-Y (the face/head)
        let targetMesh = null;
        let targetPrimitive = null;
        let bestMaxY = -Infinity;
        for (const mesh of json.meshes || []) {
            for (const prim of mesh.primitives) {
                if (prim.targets && prim.targets.length > 0) {
                    // Compute max Y from position accessor to find the top-most mesh (face)
                    const posAcc = json.accessors[prim.attributes.POSITION];
                    const posBV = json.bufferViews[posAcc.bufferView];
                    const posOff = (posBV.byteOffset || 0) + (posAcc.byteOffset || 0);
                    const positions = new Float32Array(bin.buffer, bin.byteOffset + posOff, posAcc.count * 3);
                    let maxY = -Infinity;
                    for (let i = 0; i < posAcc.count; i++) {
                        const y = positions[i*3+1];
                        if (y > maxY) maxY = y;
                    }
                    if (maxY > bestMaxY) {
                        bestMaxY = maxY;
                        targetMesh = mesh;
                        targetPrimitive = prim;
                    }
                }
            }
        }

        if (!targetPrimitive) {
            throw new Error('No morph targets found in GLB');
        }
        console.log(`[webgl2] Selected head primitive with maxY=${bestMaxY.toFixed(3)}`);

        this.blendshapeNames = targetMesh.extras?.targetNames || [];
        console.log(`[webgl2] Blendshapes: ${this.blendshapeNames.length} names`);

        const buffer = bin;

        // Base positions
        const posBV = json.bufferViews[targetPrimitive.attributes.POSITION];
        const posAcc = json.accessors[targetPrimitive.attributes.POSITION];
        const posOffset = (posBV.byteOffset || 0) + (posAcc.byteOffset || 0);
        const positions = new Float32Array(buffer.buffer, buffer.byteOffset + posOffset, posAcc.count * 3);

        // Track bounds from base positions
        for (let i = 0; i < posAcc.count; i++) {
            const x = positions[i*3], y = positions[i*3+1], z = positions[i*3+2];
            if (x < this.modelBounds.min[0]) this.modelBounds.min[0] = x;
            if (y < this.modelBounds.min[1]) this.modelBounds.min[1] = y;
            if (z < this.modelBounds.min[2]) this.modelBounds.min[2] = z;
            if (x > this.modelBounds.max[0]) this.modelBounds.max[0] = x;
            if (y > this.modelBounds.max[1]) this.modelBounds.max[1] = y;
            if (z > this.modelBounds.max[2]) this.modelBounds.max[2] = z;
        }

        // Base normals
        const normBV = json.bufferViews[targetPrimitive.attributes.NORMAL];
        const normAcc = json.accessors[targetPrimitive.attributes.NORMAL];
        const normOffset = (normBV.byteOffset || 0) + (normAcc.byteOffset || 0);
        const normals = new Float32Array(buffer.buffer, buffer.byteOffset + normOffset, normAcc.count * 3);

        // Morph targets
        const morphTargets = [];
        for (let t = 0; t < targetPrimitive.targets.length; t++) {
            const target = targetPrimitive.targets[t];
            const tPosAcc = json.accessors[target.POSITION];
            const tPosBV = json.bufferViews[tPosAcc.bufferView];
            const tPosOff = (tPosBV.byteOffset || 0) + (tPosAcc.byteOffset || 0);
            const tPositions = new Float32Array(buffer.buffer, buffer.byteOffset + tPosOff, tPosAcc.count * 3);
            morphTargets.push(tPositions);
        }

        // Indices
        let indices = null;
        if (targetPrimitive.indices !== undefined) {
            const idxAcc = json.accessors[targetPrimitive.indices];
            const idxBV = json.bufferViews[idxAcc.bufferView];
            const idxOff = (idxBV.byteOffset || 0) + (idxAcc.byteOffset || 0);
            if (idxAcc.componentType === 5123) {
                indices = new Uint16Array(buffer.buffer, buffer.byteOffset + idxOff, idxAcc.count);
            } else {
                indices = new Uint32Array(buffer.buffer, buffer.byteOffset + idxOff, idxAcc.count);
            }
        }

        return {
            basePositions: positions,
            baseNormals: normals,
            morphTargets: morphTargets,
            indices: indices,
            vertexCount: posAcc.count,
            indexCount: indices ? indices.length : posAcc.count
        };
    }

    setupGL() {
        const gl = this.gl;

        // Simple vertex shader
        const vsSource = `#version 300 es
            precision highp float;
            layout(location = 0) in vec3 aPosition;
            layout(location = 1) in vec3 aNormal;

            uniform mat4 uModelViewMatrix;
            uniform mat4 uProjectionMatrix;
            uniform mat3 uNormalMatrix;

            out vec3 vNormal;
            out vec3 vPosition;
            out float vDepth;

            void main() {
                vec4 mvPosition = uModelViewMatrix * vec4(aPosition, 1.0);
                gl_Position = uProjectionMatrix * mvPosition;
                vNormal = normalize(uNormalMatrix * aNormal);
                vPosition = aPosition;
                vDepth = -mvPosition.z;
            }
        `;

        const fsSource = `#version 300 es
            precision highp float;
            in vec3 vNormal;
            in vec3 vPosition;
            in float vDepth;
            out vec4 fragColor;

            uniform vec3 uLightDir;
            uniform float uTime;

            void main() {
                vec3 normal = normalize(vNormal);
                float diff = max(dot(normal, -normalize(uLightDir)), 0.0);
                float ambient = 0.35;

                // Subsurface scattering for skin
                float subsurface = max(dot(normal, normalize(vec3(-uLightDir.x, 0.0, -uLightDir.z))), 0.0);
                float sss = pow(subsurface, 3.0) * 0.25;

                vec3 baseColor = vec3(0.82, 0.62, 0.52);
                vec3 litColor = baseColor * (ambient + diff * 0.65 + sss);

                // Specular
                vec3 viewDir = normalize(-vPosition);
                vec3 halfDir = normalize(-normalize(uLightDir) + viewDir);
                float spec = pow(max(dot(normal, halfDir), 0.0), 32.0);
                litColor += vec3(1.0) * spec * 0.15;

                // Rim light
                float rim = 1.0 - max(dot(viewDir, normal), 0.0);
                litColor += vec3(0.3, 0.4, 0.5) * pow(rim, 3.0) * 0.25;

                // Depth fog
                float fog = exp(-vDepth * vDepth * 0.015);
                litColor = mix(vec3(0.05, 0.05, 0.08), litColor, clamp(fog, 0.0, 1.0));

                fragColor = vec4(litColor, 1.0);
            }
        `;

        this.program = this.createProgram(vsSource, fsSource);

        // Create buffers
        this.posBuffer = gl.createBuffer();
        this.normBuffer = gl.createBuffer();
        this.indexBuffer = gl.createBuffer();

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.indices, gl.STATIC_DRAW);

        // Determine index type
        this.indexType = (this.mesh.indices instanceof Uint32Array) ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
        this.vao = gl.createVertexArray();
        gl.bindVertexArray(this.vao);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.normBuffer);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
        gl.bindVertexArray(null);

        // Uniforms
        this.uniforms = {
            modelViewMatrix: gl.getUniformLocation(this.program, 'uModelViewMatrix'),
            projectionMatrix: gl.getUniformLocation(this.program, 'uProjectionMatrix'),
            normalMatrix: gl.getUniformLocation(this.program, 'uNormalMatrix'),
            lightDir: gl.getUniformLocation(this.program, 'uLightDir'),
            time: gl.getUniformLocation(this.program, 'uTime')
        };

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        // gl.enable(gl.CULL_FACE); // disabled: 180° rotation reverses winding
        // gl.cullFace(gl.BACK);

        this.resize(this.canvas.clientWidth, this.canvas.clientHeight);
    }

    centerCamera() {
        const b = this.modelBounds;
        const sx = 16.0, sy = 16.0, sz = 16.0;
        const minX = b.min[0] * sx, maxX = b.max[0] * sx;
        const minY = b.min[1] * sy, maxY = b.max[1] * sy;
        const minZ = b.min[2] * sz, maxZ = b.max[2] * sz;
        const cx = (minX + maxX) / 2;
        // Face center is roughly 55-58% up from feet on full-body avatars
        const cy = minY + (maxY - minY) * 0.58;
        const cz = (minZ + maxZ) / 2;
        const height = maxY - minY;
        const dist = Math.max(8, height * 0.22);
        this.camera.eye = [cx, cy, cz + dist];
        this.camera.center = [cx, cy, cz];
        console.log('[WebGL2] Auto-centered camera on model. Center:', this.camera.center, 'Eye:', this.camera.eye);
    }

    createProgram(vsSource, fsSource) {
        const gl = this.gl;
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vsSource);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
            throw new Error('VS compile error: ' + gl.getShaderInfoLog(vs));
        }
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fsSource);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
            throw new Error('FS compile error: ' + gl.getShaderInfoLog(fs));
        }
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error('Link error: ' + gl.getProgramInfoLog(program));
        }
        return program;
    }

    resize(width, height) {
        const canvas = this.canvas;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        this.gl.viewport(0, 0, canvas.width, canvas.height);
        this.aspect = width / height;
    }

    // Apply morph targets on CPU
    updateGeometry() {
        const mesh = this.mesh;
        const weights = this.morphWeights;
        const basePos = mesh.basePositions;
        const baseNorm = mesh.baseNormals;
        const targets = mesh.morphTargets;
        const count = mesh.vertexCount;

        // Copy base
        this.workPositions.set(basePos);
        this.workNormals.set(baseNorm);

        // Apply weighted morph deltas
        const maxTargets = Math.min(targets.length, weights.length);
        for (let t = 0; t < maxTargets; t++) {
            const w = weights[t];
            if (Math.abs(w) < 0.0001) continue;

            const deltas = targets[t];
            for (let i = 0; i < count * 3; i++) {
                this.workPositions[i] += deltas[i] * w;
            }
        }

        // Recompute normals from morphed positions (simple face-normal averaging)
        // For now, just use base normals + approximate deformation
        // Full normal recomputation would require face data

        // Upload to GPU
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.workPositions, gl.DYNAMIC_DRAW);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.normBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.workNormals, gl.DYNAMIC_DRAW);
    }

    setBlendshapes(weights) {
        // weights is an object like {jawOpen: 0.5, ...}
        const maxTargets = Math.min(this.morphTargetCount, 52);
        for (let i = 0; i < maxTargets; i++) {
            const name = this.blendshapeNames[i];
            if (name && weights[name] !== undefined) {
                this.morphWeights[i] = weights[name];
            } else {
                this.morphWeights[i] = 0;
            }
        }
    }

    setBlendshapesArray(arr) {
        const maxTargets = Math.min(this.morphTargetCount, 52, arr.length);
        for (let i = 0; i < maxTargets; i++) {
            this.morphWeights[i] = arr[i];
        }
        for (let i = maxTargets; i < 52; i++) {
            this.morphWeights[i] = 0;
        }
    }

    render(dt) {
        const gl = this.gl;
        this.time += dt;

        // Update geometry with current morph weights
        this.updateGeometry();

        gl.clearColor(0.05, 0.05, 0.08, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.useProgram(this.program);
        gl.bindVertexArray(this.vao);

        // Camera matrices
        const view = this.lookAt(this.camera.eye, this.camera.center, this.camera.up);
        const proj = this.perspective(45 * Math.PI / 180, this.aspect, 0.1, 100);
        const scale = this.scaleM(16.0, 16.0, 16.0);
        const rotY = this.rotateY(Math.PI);
        const model = this.multiply(rotY, scale);
        const modelView = this.multiply(model, view); // fixed: model first, then view
        const normalMat = this.normalMatrix(modelView);

        gl.uniformMatrix4fv(this.uniforms.projectionMatrix, false, proj);
        gl.uniformMatrix4fv(this.uniforms.modelViewMatrix, false, modelView);
        gl.uniformMatrix3fv(this.uniforms.normalMatrix, false, normalMat);
        gl.uniform3f(this.uniforms.lightDir, 0.5, 1.0, 0.5);
        gl.uniform1f(this.uniforms.time, this.time);

        gl.drawElements(gl.TRIANGLES, this.mesh.indexCount, this.indexType, 0);
    }

    // Matrix math helpers
    lookAt(eye, center, up) {
        const z = this.normalize([eye[0]-center[0], eye[1]-center[1], eye[2]-center[2]]);
        const x = this.normalize(this.cross(up, z));
        const y = this.cross(z, x);
        return new Float32Array([
            x[0], y[0], z[0], 0,
            x[1], y[1], z[1], 0,
            x[2], y[2], z[2], 0,
            -this.dot(x, eye), -this.dot(y, eye), -this.dot(z, eye), 1
        ]);
    }

    perspective(fov, aspect, near, far) {
        const f = 1.0 / Math.tan(fov / 2);
        const nf = 1 / (near - far);
        return new Float32Array([
            f / aspect, 0, 0, 0,
            0, f, 0, 0,
            0, 0, (far + near) * nf, -1,
            0, 0, 2 * far * near * nf, 0
        ]);
    }

    rotateY(angle) {
        const c = Math.cos(angle), s = Math.sin(angle);
        return new Float32Array([
            c, 0, s, 0,
            0, 1, 0, 0,
            -s, 0, c, 0,
            0, 0, 0, 1
        ]);
    }

    scaleM(sx, sy, sz) {
        return new Float32Array([
            sx, 0, 0, 0,
            0, sy, 0, 0,
            0, 0, sz, 0,
            0, 0, 0, 1
        ]);
    }

    multiply(a, b) {
        const out = new Float32Array(16);
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                let sum = 0;
                for (let k = 0; k < 4; k++) sum += a[i * 4 + k] * b[k * 4 + j];
                out[i * 4 + j] = sum;
            }
        }
        return out;
    }

    normalMatrix(m) {
        const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
        const det = a[0]*(a[4]*a[8]-a[5]*a[7]) - a[1]*(a[3]*a[8]-a[5]*a[6]) + a[2]*(a[3]*a[7]-a[4]*a[6]);
        const invDet = 1 / det;
        return new Float32Array([
            (a[4]*a[8]-a[5]*a[7])*invDet, (a[2]*a[7]-a[1]*a[8])*invDet, (a[1]*a[5]-a[2]*a[4])*invDet,
            (a[5]*a[6]-a[3]*a[8])*invDet, (a[0]*a[8]-a[2]*a[6])*invDet, (a[2]*a[3]-a[0]*a[5])*invDet,
            (a[3]*a[7]-a[4]*a[6])*invDet, (a[1]*a[6]-a[0]*a[7])*invDet, (a[0]*a[4]-a[1]*a[3])*invDet
        ]);
    }

    normalize(v) {
        const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
        return len > 0 ? [v[0]/len, v[1]/len, v[2]/len] : [0,0,0];
    }
    cross(a, b) {
        return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
    }
    dot(a, b) {
        return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
    }
}

window.WebGL2AvatarRenderer = WebGL2AvatarRenderer;




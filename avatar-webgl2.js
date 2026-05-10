// WebGL2 Fallback Renderer for Avatar Platform
// CPU-based morph target deformation + WebGL2 rendering
// Compatible with all devices that support WebGL2

class WebGL2AvatarRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false });
        if (!this.gl) {
            throw new Error('WebGL2 not available');
        }
        this.gl.enable(this.gl.BLEND);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

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
        this.workPositions = null;
        this.workNormals = null;
        // All draw calls (face primitives share vertices, body/hair have own vertices)
        this.drawList = [];
    }

    async loadModel(url) {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const glb = this.parseGLB(new Uint8Array(buffer));
        
        // Extract morphable face geometry
        this.mesh = this.extractFaceMesh(glb);
        this.morphTargetCount = this.mesh.morphTargets.length;
        
        // Create draw entries for each face primitive (all share same morphed vertices)
        this.faceDraws = [];
        for (const prim of this.mesh.primitives) {
            this.faceDraws.push({
                posBuffer: null,
                normBuffer: null,
                indexBuffer: null,
                vao: null,
                indexType: prim.indexType,
                indexCount: prim.indexCount,
                baseColor: prim.baseColor
            });
        }

        this.workPositions = new Float32Array(this.mesh.vertexCount * 3);
        this.workNormals = new Float32Array(this.mesh.vertexCount * 3);

        this.setupGL();
        this.centerCamera();
    }

    parseGLB(data) {
        const header = new DataView(data.buffer, data.byteOffset, 12);
        const magic = header.getUint32(0, true);
        if (magic !== 0x46546C67) throw new Error('Not a GLB file');
        const length = header.getUint32(8, true);

        let offset = 12;
        let jsonChunk = null, binChunk = null;
        while (offset < length) {
            const chunkLength = new DataView(data.buffer, data.byteOffset + offset, 8).getUint32(0, true);
            const chunkType = new DataView(data.buffer, data.byteOffset + offset, 8).getUint32(4, true);
            const chunkData = data.slice(offset + 8, offset + 8 + chunkLength);
            if (chunkType === 0x4E4F534A) jsonChunk = JSON.parse(new TextDecoder().decode(chunkData));
            else if (chunkType === 0x004E4942) binChunk = chunkData;
            offset += 8 + chunkLength;
        }
        return { json: jsonChunk, bin: binChunk };
    }

    // Extract ALL primitives from the face mesh (they share vertices, have different index subsets)
    extractFaceMesh(glb) {
        const json = glb.json;
        const bin = glb.bin;

        // Find mesh with morph targets
        let targetMesh = null;
        for (const mesh of json.meshes || []) {
            if (mesh.primitives.some(p => p.targets && p.targets.length > 0)) {
                targetMesh = mesh;
                break;
            }
        }
        if (!targetMesh) throw new Error('No morph targets found in GLB');

        this.blendshapeNames = targetMesh.extras?.targetNames || [];

        // Shared vertex data (all face primitives share the same POSITION accessor)
        const meshPrims = targetMesh.primitives;
        const prim0 = meshPrims[0];
        const posAcc = json.accessors[prim0.attributes.POSITION];
        const posBV = json.bufferViews[posAcc.bufferView];
        const posOff = (posBV.byteOffset || 0) + (posAcc.byteOffset || 0);
        const positions = new Float32Array(bin.buffer, bin.byteOffset + posOff, posAcc.count * 3);

        // Track bounds
        for (let i = 0; i < posAcc.count; i++) {
            const [x, y, z] = [positions[i*3], positions[i*3+1], positions[i*3+2]];
            for (let ax = 0; ax < 3; ax++) {
                const v = [x, y, z][ax];
                if (v < this.modelBounds.min[ax]) this.modelBounds.min[ax] = v;
                if (v > this.modelBounds.max[ax]) this.modelBounds.max[ax] = v;
            }
        }

        const normBV = json.bufferViews[prim0.attributes.NORMAL];
        const normAcc = json.accessors[prim0.attributes.NORMAL];
        const normOff = (normBV.byteOffset || 0) + (normAcc.byteOffset || 0);
        const normals = new Float32Array(bin.buffer, bin.byteOffset + normOff, normAcc.count * 3);

        // Morph targets (shared across all primitives)
        const morphTargets = [];
        for (let t = 0; t < prim0.targets.length; t++) {
            const tPosAcc = json.accessors[prim0.targets[t].POSITION];
            const tPosBV = json.bufferViews[tPosAcc.bufferView];
            const tPosOff = (tPosBV.byteOffset || 0) + (tPosAcc.byteOffset || 0);
            morphTargets.push(new Float32Array(bin.buffer, bin.byteOffset + tPosOff, tPosAcc.count * 3));
        }

        // Extract each primitive's indices and material color
        const primitives = [];
        for (const prim of meshPrims) {
            let indices = null;
            let indexType = this.gl.UNSIGNED_SHORT;
            let indexCount = posAcc.count;
            if (prim.indices !== undefined) {
                const idxAcc = json.accessors[prim.indices];
                const idxBV = json.bufferViews[idxAcc.bufferView];
                const idxOff = (idxBV.byteOffset || 0) + (idxAcc.byteOffset || 0);
                if (idxAcc.componentType === 5123) {
                    indices = new Uint16Array(bin.buffer, bin.byteOffset + idxOff, idxAcc.count);
                    indexType = this.gl.UNSIGNED_SHORT;
                } else {
                    indices = new Uint32Array(bin.buffer, bin.byteOffset + idxOff, idxAcc.count);
                    indexType = this.gl.UNSIGNED_INT;
                }
                indexCount = idxAcc.count;
            }

            // Estimate color from material or index count heuristic
            let baseColor = [0.82, 0.62, 0.52]; // default skin
            if (prim.material !== undefined && json.materials && json.materials[prim.material]) {
                const mat = json.materials[prim.material];
                if (mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorFactor) {
                    baseColor = mat.pbrMetallicRoughness.baseColorFactor.slice(0, 3);
                }
            }

            primitives.push({ positions, normals, indices, indexType, indexCount, baseColor });
        }

        return {
            vertexCount: posAcc.count,
            basePositions: positions,
            baseNormals: normals,
            morphTargets,
            primitives
        };
    }

    setupGL() {
        const gl = this.gl;

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

        // Brighter lighting for better visibility
        const fsSource = `#version 300 es
            precision highp float;
            in vec3 vNormal;
            in vec3 vPosition;
            in float vDepth;
            out vec4 fragColor;
            uniform vec3 uLightDir;
            uniform vec3 uBaseColor;
            uniform float uTime;
            void main() {
                vec3 normal = normalize(vNormal);
                float diff = max(dot(normal, normalize(uLightDir)), 0.0);
                float ambient = 0.55;

                float subsurface = max(dot(normal, normalize(vec3(-uLightDir.x, 0.0, -uLightDir.z))), 0.0);
                float sss = pow(subsurface, 3.0) * 0.2;

                vec3 baseColor = uBaseColor;
                vec3 litColor = baseColor * (ambient + diff * 0.55 + sss);

                vec3 viewDir = normalize(-vPosition);
                vec3 halfDir = normalize(normalize(uLightDir) + viewDir);
                float spec = pow(max(dot(normal, halfDir), 0.0), 32.0);
                litColor += vec3(1.0) * spec * 0.2;

                float rim = 1.0 - max(dot(viewDir, normal), 0.0);
                litColor += vec3(0.3, 0.4, 0.5) * pow(rim, 3.0) * 0.2;

                fragColor = vec4(litColor, 1.0);
            }
        `;

        this.program = this.createProgram(vsSource, fsSource);

        this.uniforms = {
            modelViewMatrix: gl.getUniformLocation(this.program, 'uModelViewMatrix'),
            projectionMatrix: gl.getUniformLocation(this.program, 'uProjectionMatrix'),
            normalMatrix: gl.getUniformLocation(this.program, 'uNormalMatrix'),
            lightDir: gl.getUniformLocation(this.program, 'uLightDir'),
            baseColor: gl.getUniformLocation(this.program, 'uBaseColor'),
            time: gl.getUniformLocation(this.program, 'uTime')
        };

        // Create buffers for each face primitive
        for (const draw of this.faceDraws) {
            draw.posBuffer = gl.createBuffer();
            draw.normBuffer = gl.createBuffer();
            draw.indexBuffer = gl.createBuffer();
            draw.vao = gl.createVertexArray();
        }

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);

        this.resize(this.canvas.clientWidth, this.canvas.clientHeight);
    }

    centerCamera() {
        const b = this.modelBounds;
        const sx = 16.0, sy = 16.0, sz = 16.0;
        const minX = b.min[0] * sx, maxX = b.max[0] * sx;
        const minY = b.min[1] * sy, maxY = b.max[1] * sy;
        const minZ = b.min[2] * sz, maxZ = b.max[2] * sz;
        const cx = (minX + maxX) / 2;
        const cy = minY + (maxY - minY) * 0.58;
        const cz = (minZ + maxZ) / 2;
        const height = maxY - minY;
        const dist = Math.max(8, height * 0.22);
        this.camera.eye = [cx, cy, cz + dist];
        this.camera.center = [cx, cy, cz];
        console.log('[WebGL2] Centered. Eye:', this.camera.eye, 'Center:', this.camera.center);
    }

    createProgram(vsSource, fsSource) {
        const gl = this.gl;
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vsSource);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error('VS: ' + gl.getShaderInfoLog(vs));
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fsSource);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error('FS: ' + gl.getShaderInfoLog(fs));
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(program));
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

    updateGeometry() {
        const mesh = this.mesh;
        const weights = this.morphWeights;
        const count = mesh.vertexCount;

        this.workPositions.set(mesh.basePositions);
        this.workNormals.set(mesh.baseNormals);

        const maxTargets = Math.min(mesh.morphTargets.length, weights.length);
        for (let t = 0; t < maxTargets; t++) {
            const w = weights[t];
            if (Math.abs(w) < 0.0001) continue;
            const deltas = mesh.morphTargets[t];
            for (let i = 0; i < count * 3; i++) {
                this.workPositions[i] += deltas[i] * w;
            }
        }

        // Upload shared vertices to all draw buffers
        const gl = this.gl;
        for (const draw of this.faceDraws) {
            gl.bindBuffer(gl.ARRAY_BUFFER, draw.posBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, this.workPositions, gl.DYNAMIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, draw.normBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, this.workNormals, gl.DYNAMIC_DRAW);
            if (draw.indices) {
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, draw.indexBuffer);
                gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, draw.indices, gl.STATIC_DRAW);
            }
        }

        // Setup VAOs
        for (const draw of this.faceDraws) {
            gl.bindVertexArray(draw.vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, draw.posBuffer);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ARRAY_BUFFER, draw.normBuffer);
            gl.enableVertexAttribArray(1);
            gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
            if (draw.indices) {
                gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, draw.indexBuffer);
            }
            gl.bindVertexArray(null);
        }
    }

    setBlendshapes(weights) {
        for (let i = 0; i < this.morphTargetCount && i < 52; i++) {
            const name = this.blendshapeNames[i];
            this.morphWeights[i] = (name && weights[name] !== undefined) ? weights[name] : 0;
        }
    }

    setBlendshapesArray(arr) {
        const len = Math.min(this.morphTargetCount, 52, arr.length);
        for (let i = 0; i < len; i++) this.morphWeights[i] = arr[i];
        for (let i = len; i < 52; i++) this.morphWeights[i] = 0;
    }

    render(dt) {
        const gl = this.gl;
        this.time += dt;
        this.updateGeometry();

        // Clear with transparent background
        gl.clearColor(0.0, 0.0, 0.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.useProgram(this.program);

        const view = this.lookAt(this.camera.eye, this.camera.center, this.camera.up);
        const proj = this.perspective(45 * Math.PI / 180, this.aspect, 0.1, 100);
        const scale = this.scaleM(16.0, 16.0, 16.0);
        const rotY = this.rotateY(Math.PI);
        const model = this.multiply(rotY, scale);
        const modelView = this.multiply(model, view);
        const normalMat = this.normalMatrix(modelView);

        gl.uniformMatrix4fv(this.uniforms.projectionMatrix, false, proj);
        gl.uniformMatrix4fv(this.uniforms.modelViewMatrix, false, modelView);
        gl.uniformMatrix3fv(this.uniforms.normalMatrix, false, normalMat);
        gl.uniform3f(this.uniforms.lightDir, 0.5, 1.0, 0.5);
        gl.uniform1f(this.uniforms.time, this.time);

        // Draw all face primitives (eyes, skin, teeth, etc.)
        for (const draw of this.faceDraws) {
            gl.uniform3f(this.uniforms.baseColor, draw.baseColor[0], draw.baseColor[1], draw.baseColor[2]);
            gl.bindVertexArray(draw.vao);
            if (draw.indices) {
                gl.drawElements(gl.TRIANGLES, draw.indexCount, draw.indexType, 0);
            } else {
                gl.drawArrays(gl.TRIANGLES, 0, draw.indexCount);
            }
        }
    }

    lookAt(eye, center, up) {
        const z = this.normalize([eye[0]-center[0], eye[1]-center[1], eye[2]-center[2]]);
        const x = this.normalize(this.cross(up, z));
        const y = this.cross(z, x);
        return new Float32Array([
            x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
            -this.dot(x, eye), -this.dot(y, eye), -this.dot(z, eye), 1
        ]);
    }

    perspective(fov, aspect, near, far) {
        const f = 1.0 / Math.tan(fov / 2);
        const nf = 1 / (near - far);
        return new Float32Array([
            f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0
        ]);
    }

    rotateY(a) { const c=Math.cos(a),s=Math.sin(a); return new Float32Array([c,0,s,0, 0,1,0,0, -s,0,c,0, 0,0,0,1]); }
    scaleM(sx, sy, sz) { return new Float32Array([sx,0,0,0, 0,sy,0,0, 0,0,sz,0, 0,0,0,1]); }
    multiply(a, b) {
        const o = new Float32Array(16);
        for (let i=0;i<4;i++) for (let j=0;j<4;j++) { let s=0; for(let k=0;k<4;k++) s+=a[i*4+k]*b[k*4+j]; o[i*4+j]=s; }
        return o;
    }
    normalMatrix(m) {
        const a=[m[0],m[1],m[2],m[4],m[5],m[6],m[8],m[9],m[10]];
        const d=a[0]*(a[4]*a[8]-a[5]*a[7])-a[1]*(a[3]*a[8]-a[5]*a[6])+a[2]*(a[3]*a[7]-a[4]*a[6]);
        const i=1/d;
        return new Float32Array([
            (a[4]*a[8]-a[5]*a[7])*i,(a[2]*a[7]-a[1]*a[8])*i,(a[1]*a[5]-a[2]*a[4])*i,
            (a[5]*a[6]-a[3]*a[8])*i,(a[0]*a[8]-a[2]*a[6])*i,(a[2]*a[3]-a[0]*a[5])*i,
            (a[3]*a[7]-a[4]*a[6])*i,(a[1]*a[6]-a[0]*a[7])*i,(a[0]*a[4]-a[1]*a[3])*i
        ]);
    }
    normalize(v) { const l=Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); return l>0?[v[0]/l,v[1]/l,v[2]/l]:[0,0,0]; }
    cross(a,b) { return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]; }
    dot(a,b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
}

window.WebGL2AvatarRenderer = WebGL2AvatarRenderer;

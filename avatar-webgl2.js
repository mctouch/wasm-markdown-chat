/* eslint-disable no-unused-vars */
// WebGL2 Fallback Renderer for Avatar Platform
// Draws multiple per-primitive draw calls from the GLB face mesh with morph blendshapes.
// Supports texture loading from embedded GLB images.
// Licenced under MPL-2.0

class WebGL2AvatarRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl2', {
            antialias: true,
            alpha: true,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true
        });
        if (!this.gl) throw new Error('WebGL2 not available');

        this.morphWeights  = new Float32Array(52);
        this.blendshapeNames = [];
        this.camera = { eye: [0, 24, 10], center: [0, 24, 0], up: [0, 1, 0] };
        this.time = 0;
        this.drawList = [];
        this.modelBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        this.aspect = 1;
        this.materialTextures = []; // material index -> WebGLTexture
        this.materialAlphaModes = []; // material index -> 'OPAQUE' | 'BLEND' | 'MASK'
    }

    async loadModel(url) {
        const resp = await fetch(url);
        const data = new Uint8Array(await resp.arrayBuffer());
        const { json, bin } = this._parseGlb(data);
        this.json = json;
        this.bin  = bin;

        this._buildDrawList({ json, bin });
        await this._loadTextures({ json, bin });
        this._setupShaders();
        this.centerCamera();
    }

    _parseGlb(data) {
        const dv = new DataView(data.buffer, data.byteOffset, 12);
        const totalLen = dv.getUint32(8, true);
        let off = 12;
        let json, bin;
        while (off < totalLen) {
            const cl = new DataView(data.buffer, data.byteOffset + off, 8).getUint32(0, true);
            const ct = new DataView(data.buffer, data.byteOffset + off, 8).getUint32(4, true);
            const chunk = data.slice(off + 8, off + 8 + cl);
            if (ct === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(chunk));
            else if (ct === 0x004E4942) bin = chunk;
            off += 8 + cl;
        }
        return { json, bin };
    }

    _accView({ json, bin }, accessorIndex) {
        const acc = json.accessors[accessorIndex];
        const bv  = json.bufferViews[acc.bufferView];
        const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
        const len = acc.count;
        const b = bin.buffer;
        const bo = bin.byteOffset;
        switch (acc.componentType) {
            case 5126: return { type: 'float32', view: new Float32Array(b, bo + off, len * (acc.type === 'VEC2' ? 2 : (acc.type === 'VEC3' ? 3 : 4))), count: len, target: acc.type };
            case 5123: return { type: 'uint16',  view: new Uint16Array(b, bo + off, len),   count: len };
            case 5125: return { type: 'uint32',  view: new Uint32Array(b, bo + off, len),   count: len };
        }
        throw new Error('Unknown accessor type: ' + acc.componentType);
    }

    async _loadTextures({ json, bin }) {
        const gl = this.gl;
        // Create a default white texture
        const whiteTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, whiteTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255,255,255,255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this.defaultTexture = whiteTex;

        const textures = [];
        if (json.images) {
            for (let ii = 0; ii < json.images.length; ii++) {
                const img = json.images[ii];
                if (img.bufferView !== undefined) {
                    const bv = json.bufferViews[img.bufferView];
                    const off = bv.byteOffset || 0;
                    const len = bv.byteLength;
                    const blob = new Blob([new Uint8Array(bin.buffer, bin.byteOffset + off, len)], { type: img.mimeType || 'image/png' });
                    try {
                        const bitmap = await createImageBitmap(blob);
                        const tex = gl.createTexture();
                        gl.bindTexture(gl.TEXTURE_2D, tex);
                        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                        gl.generateMipmap(gl.TEXTURE_2D);
                        textures.push(tex);
                        console.log(`[WebGL2] Loaded texture ${ii}: ${bitmap.width}x${bitmap.height}`);
                    } catch (e) {
                        console.warn(`[WebGL2] Failed to load texture ${ii}:`, e);
                        textures.push(whiteTex);
                    }
                } else {
                    textures.push(whiteTex);
                }
            }
        }

        // Map material -> baseColor texture
        if (json.materials) {
            for (let mi = 0; mi < json.materials.length; mi++) {
                const mat = json.materials[mi];
                let tex = whiteTex;
                if (mat && mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorTexture) {
                    const texIdx = mat.pbrMetallicRoughness.baseColorTexture.index;
                    if (texIdx !== undefined && json.textures && json.textures[texIdx]) {
                        const imgIdx = json.textures[texIdx].source;
                        if (imgIdx !== undefined && textures[imgIdx]) tex = textures[imgIdx];
                    }
                }
                this.materialTextures.push(tex);
                this.materialAlphaModes.push(mat.alphaMode || 'OPAQUE');
            }
        }
    }

    _setupShaders() {
        const gl = this.gl;
        const vsSource = [
            '#version 300 es',
            'precision highp float;',
            'layout(location = 0) in vec3 aPos;',
            'layout(location = 1) in vec3 aNorm;',
            'layout(location = 2) in vec2 aUV;',
            'uniform mat4 uMV, uP;',
            'uniform mat3 uN;',
            'out vec3 vN, vP;',
            'out vec2 vUV;',
            'void main(){',
            '    vec4 mv = uMV * vec4(aPos, 1.0);',
            '    gl_Position = uP * mv;',
            '    vN = normalize(uN * aNorm);',
            '    vP = aPos;',
            '    vUV = aUV;',
            '}'
        ].join('\n');

        const fsSource = [
            '#version 300 es',
            'precision highp float;',
            'in vec3 vN, vP;',
            'in vec2 vUV;',
            'out vec4 oCol;',
            'uniform sampler2D uTex;',
            'uniform vec3 uBaseColor;',
            'uniform bool uHasTex;',
            'void main(){',
            '    vec4 texCol = uHasTex ? texture(uTex, vUV) : vec4(uBaseColor, 1.0);',
            '    if (texCol.a < 0.05) discard;',
            '    vec3 L = normalize(vec3(0.5, 1.0, 0.5));',
            '    float diff = max(dot(normalize(vN), L), 0.0);',
            '    float amb = 0.45;',
            '    vec3 col = texCol.rgb * (amb + diff * 0.55);',
            '    float rim = 1.0 - max(dot(normalize(-vP), normalize(vN)), 0.0);',
            '    col += vec3(0.2, 0.25, 0.3) * pow(rim, 3.0) * 0.12;',
            '    oCol = vec4(col, texCol.a);',
            '}'
        ].join('\n');
        this.prog = this._compile(vsSource, fsSource);
        this.uloc = {
            mv: gl.getUniformLocation(this.prog, 'uMV'),
            p:  gl.getUniformLocation(this.prog, 'uP'),
            n:  gl.getUniformLocation(this.prog, 'uN'),
            bc: gl.getUniformLocation(this.prog, 'uBaseColor'),
            tex: gl.getUniformLocation(this.prog, 'uTex'),
            hasTex: gl.getUniformLocation(this.prog, 'uHasTex')
        };
    }

    _buildDrawList({ json, bin }) {
        const gl = this.gl;

        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);

        this.drawList = [];

        // --- 1. Process face mesh (has morph targets) ---
        let faceMesh = null;
        for (const mesh of json.meshes || []) {
            if (mesh.primitives.some(p => p.targets && p.targets.length > 0)) {
                faceMesh = mesh;
                break;
            }
        }
        if (faceMesh) {
            this.blendshapeNames = faceMesh.extras?.targetNames || [];
            this.morphTargetCount = faceMesh.primitives[0].targets.length;

            const posInfo0 = this._accView({ json, bin }, faceMesh.primitives[0].attributes.POSITION);
            const faceVerts = posInfo0.count;
            const facePositions = new Float32Array(posInfo0.view);
            const normInfo0 = this._accView({ json, bin }, faceMesh.primitives[0].attributes.NORMAL);
            const faceNormals = new Float32Array(normInfo0.view);

            for (let i=0;i<faceVerts;i++){
                const x=facePositions[i*3], y=facePositions[i*3+1], z=facePositions[i*3+2];
                if(x<this.modelBounds.min[0]) this.modelBounds.min[0]=x;
                if(y<this.modelBounds.min[1]) this.modelBounds.min[1]=y;
                if(z<this.modelBounds.min[2]) this.modelBounds.min[2]=z;
                if(x>this.modelBounds.max[0]) this.modelBounds.max[0]=x;
                if(y>this.modelBounds.max[1]) this.modelBounds.max[1]=y;
                if(z>this.modelBounds.max[2]) this.modelBounds.max[2]=z;
            }

            const morphTargets = [];
            for (let ti = 0; ti < this.morphTargetCount; ti++) {
                const tAccIdx = faceMesh.primitives[0].targets[ti].POSITION;
                const tInfo = this._accView({ json, bin }, tAccIdx);
                morphTargets.push(new Float32Array(tInfo.view));
            }

            // Create shared GPU buffers for morphed positions/normals
            this.facePosBuf  = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.facePosBuf);
            gl.bufferData(gl.ARRAY_BUFFER, facePositions, gl.DYNAMIC_DRAW);
            this.faceNormBuf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.faceNormBuf);
            gl.bufferData(gl.ARRAY_BUFFER, faceNormals, gl.DYNAMIC_DRAW);
            this.workPositions = new Float32Array(faceVerts * 3);
            this.workNormals  = new Float32Array(faceVerts * 3);

            for (const prim of faceMesh.primitives) {
                let indexCount = faceVerts;
                let idxBuf = null;
                let idxType = gl.UNSIGNED_SHORT;
                if (prim.indices !== undefined) {
                    const idxInfo = this._accView({ json, bin }, prim.indices);
                    indexCount = idxInfo.count;
                    idxType = idxInfo.type === 'uint16' ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
                    idxBuf = gl.createBuffer();
                    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
                    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxInfo.view, gl.STATIC_DRAW);
                }

                // UV buffer
                let uvBuf = null;
                if (prim.attributes.TEXCOORD_0 !== undefined) {
                    const uvInfo = this._accView({ json, bin }, prim.attributes.TEXCOORD_0);
                    uvBuf = gl.createBuffer();
                    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
                    gl.bufferData(gl.ARRAY_BUFFER, uvInfo.view, gl.STATIC_DRAW);
                }

                const vao = gl.createVertexArray();
                gl.bindVertexArray(vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.facePosBuf);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.faceNormBuf);
                gl.enableVertexAttribArray(1);
                gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
                if (uvBuf) {
                    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
                    gl.enableVertexAttribArray(2);
                    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
                }
                if (idxBuf) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
                gl.bindVertexArray(null);

                let baseColor = [0.82, 0.62, 0.52];
                let materialIdx = -1;
                if (prim.material !== undefined && json.materials && json.materials[prim.material]) {
                    const mat = json.materials[prim.material];
                    materialIdx = prim.material;
                    if (mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorFactor) {
                        baseColor = mat.pbrMetallicRoughness.baseColorFactor.slice(0, 3);
                    }
                }
                if (baseColor[0] > 0.99 && baseColor[1] > 0.99 && baseColor[2] > 0.99) {
                    if (indexCount < 1000) baseColor = [0.7, 0.1, 0.1];
                    else if (indexCount > 8000) baseColor = [0.82, 0.62, 0.52];
                    else baseColor = [0.92, 0.92, 0.95];
                }

                this.drawList.push({
                    isFace: true,
                    vao,
                    posBuf: this.facePosBuf,
                    normBuf: this.faceNormBuf,
                    idxBuf,
                    uvBuf,
                    indexCount,
                    idxType,
                    baseColor,
                    materialIdx,
                    hasMorphs: true
                });
            }

            this.sharedMorph = { positions: facePositions, normals: faceNormals, morphTargets, count: faceVerts };
        }

        // --- 2. Process static meshes (hair, body, eyes) ---
        for (const mesh of json.meshes || []) {
            const hasMorphs = mesh.primitives.some(p => p.targets && p.targets.length > 0);
            if (hasMorphs) continue;

            for (const prim of mesh.primitives) {
                const posInfo = this._accView({ json, bin }, prim.attributes.POSITION);
                const normInfo = this._accView({ json, bin }, prim.attributes.NORMAL);
                const posData = new Float32Array(posInfo.view);
                const normData = new Float32Array(normInfo.view);

                const posBuf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
                gl.bufferData(gl.ARRAY_BUFFER, posData, gl.STATIC_DRAW);
                const normBuf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
                gl.bufferData(gl.ARRAY_BUFFER, normData, gl.STATIC_DRAW);

                let idxBuf = null, idxType = gl.UNSIGNED_SHORT, indexCount = posInfo.count;
                if (prim.indices !== undefined) {
                    const idxInfo = this._accView({ json, bin }, prim.indices);
                    indexCount = idxInfo.count;
                    idxType = idxInfo.type === 'uint16' ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
                    idxBuf = gl.createBuffer();
                    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
                    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxInfo.view, gl.STATIC_DRAW);
                }

                // UV buffer
                let uvBuf = null;
                if (prim.attributes.TEXCOORD_0 !== undefined) {
                    const uvInfo = this._accView({ json, bin }, prim.attributes.TEXCOORD_0);
                    uvBuf = gl.createBuffer();
                    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
                    gl.bufferData(gl.ARRAY_BUFFER, uvInfo.view, gl.STATIC_DRAW);
                }

                const vao = gl.createVertexArray();
                gl.bindVertexArray(vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
                gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
                gl.enableVertexAttribArray(1);
                gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
                if (uvBuf) {
                    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
                    gl.enableVertexAttribArray(2);
                    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
                }
                if (idxBuf) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
                gl.bindVertexArray(null);

                let baseColor = [0.15, 0.10, 0.06];
                let materialIdx = -1;
                const mName = (mesh.name || '').toLowerCase();
                if (mName.includes('body')) baseColor = [0.20, 0.15, 0.12];
                else if (mName.includes('eye')) baseColor = [0.9, 0.9, 0.95];
                if (prim.material !== undefined && json.materials && json.materials[prim.material]) {
                    const mat = json.materials[prim.material];
                    materialIdx = prim.material;
                    const pbr = mat.pbrMetallicRoughness;
                    if (pbr && pbr.baseColorFactor) baseColor = pbr.baseColorFactor.slice(0,3);
                }

                this.drawList.push({
                    isFace: false,
                    vao, posBuf, normBuf, idxBuf, uvBuf,
                    indexCount, idxType, baseColor, materialIdx,
                    hasMorphs: false
                });
            }
        }

        this.aspect = this.canvas.clientWidth / (this.canvas.clientHeight || 1);
    }

    _compile(vsSrc, fsSrc) {
        const gl = this.gl;
        const vs = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vs, vsSrc.trim());
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error('VS: ' + gl.getShaderInfoLog(vs));
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fs, fsSrc.trim());
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error('FS: ' + gl.getShaderInfoLog(fs));
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('LINK: ' + gl.getProgramInfoLog(prog));
        return prog;
    }

    setBlendshapes(weights) {
        this.morphWeights.set(weights);
    }

    updateGeometry() {
        if (!this.sharedMorph) return;
        const gl = this.gl;
        const { positions, normals, morphTargets, count } = this.sharedMorph;
        this.workPositions.set(positions);
        this.workNormals.set(normals);
        for (let i = 0; i < count; i++) {
            let wx = 0, wy = 0, wz = 0, nx = 0, ny = 0, nz = 0;
            for (let t = 0; t < this.morphTargetCount; t++) {
                const w = this.morphWeights[t] || 0;
                if (w === 0) continue;
                const target = morphTargets[t];
                wx += target[i * 3] * w;
                wy += target[i * 3 + 1] * w;
                wz += target[i * 3 + 2] * w;
                nx += target[i * 3] * w;
                ny += target[i * 3 + 1] * w;
                nz += target[i * 3 + 2] * w;
            }
            this.workPositions[i * 3] += wx;
            this.workPositions[i * 3 + 1] += wy;
            this.workPositions[i * 3 + 2] += wz;
            this.workNormals[i * 3] += nx;
            this.workNormals[i * 3 + 1] += ny;
            this.workNormals[i * 3 + 2] += nz;
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.facePosBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.workPositions);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.faceNormBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.workNormals);
    }

    centerCamera() {
        const b = this.modelBounds;
        const sx = 16.0, sy = 16.0, sz = 16.0;
        const cx = (b.min[0] + b.max[0]) * sx / 2;
        const cy = b.min[1] * sy + (b.max[1] - b.min[1]) * sy * 0.58;
        const cz = (b.min[2] + b.max[2]) * sz / 2;
        const dist = Math.max(8, (b.max[1] - b.min[1]) * sy * 0.22);
        this.camera.eye = [cx, cy, cz + dist];
        this.camera.center = [cx, cy, cz];
    }

    resize(w, h) {
        const gl = this.gl;
        this.canvas.width = w;
        this.canvas.height = h;
        gl.viewport(0, 0, w, h);
        this.aspect = w / (h || 1);
    }

    render(dt) {
        this.time += dt;
        const gl = this.gl;
        this.updateGeometry();
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const view = this.lookAt(this.camera.eye, this.camera.center, this.camera.up);
        const proj = this.perspective(45 * Math.PI / 180, this.aspect, 0.1, 100);
        const model = this.multiply(this.rotateY(Math.PI), this.scaleM(16, 16, 16));
        const mv = this.multiply(model, view); // Safari: reversed order with transpose=false
        const nm = this.normalMatrix(mv);

        gl.useProgram(this.prog);
        gl.uniformMatrix4fv(this.uloc.p, false, proj);
        gl.uniformMatrix4fv(this.uloc.mv, false, mv);
        gl.uniformMatrix3fv(this.uloc.n, false, nm);

        for (const draw of this.drawList) {
            const tex = (draw.materialIdx >= 0 && this.materialTextures[draw.materialIdx])
                ? this.materialTextures[draw.materialIdx]
                : this.defaultTexture;
            const hasTex = (draw.materialIdx >= 0 && this.materialTextures[draw.materialIdx] !== this.defaultTexture);
            const alphaMode = (draw.materialIdx >= 0 && this.materialAlphaModes[draw.materialIdx])
                ? this.materialAlphaModes[draw.materialIdx]
                : 'OPAQUE';

            // Enable blend for transparent materials
            if (alphaMode === 'BLEND') {
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.depthMask(false);
            } else {
                gl.disable(gl.BLEND);
                gl.depthMask(true);
            }

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.uniform1i(this.uloc.tex, 0);
            gl.uniform1i(this.uloc.hasTex, hasTex ? 1 : 0);
            gl.uniform3f(this.uloc.bc, draw.baseColor[0], draw.baseColor[1], draw.baseColor[2]);

            gl.bindVertexArray(draw.vao);
            if (draw.idxBuf) gl.drawElements(gl.TRIANGLES, draw.indexCount, draw.idxType, 0);
            else gl.drawArrays(gl.TRIANGLES, 0, draw.indexCount);
        }
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
        gl.depthMask(true);
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

    lookAt(eye, center, up) {
        let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
        let zlen = Math.sqrt(zx * zx + zy * zy + zz * zz);
        zx /= zlen; zy /= zlen; zz /= zlen;
        let xx = up[1] * zz - up[2] * zy;
        let xy = up[2] * zx - up[0] * zz;
        let xz = up[0] * zy - up[1] * zx;
        let xlen = Math.sqrt(xx * xx + xy * xy + xz * xz);
        xx /= xlen; xy /= xlen; xz /= xlen;
        let yx = zy * xz - zz * xy;
        let yy = zz * xx - zx * xz;
        let yz = zx * xy - zy * xx;
        return new Float32Array([
            xx, yx, zx, 0,
            xy, yy, zy, 0,
            xz, yz, zz, 0,
            -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
            -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
            -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
            1
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

    normalMatrix(mv) {
        const a = mv;
        const out = new Float32Array(9);
        out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
        out[3] = a[4]; out[4] = a[5]; out[5] = a[6];
        out[6] = a[8]; out[7] = a[9]; out[8] = a[10];
        return out;
    }

    rotateY(a) {
        const c = Math.cos(a), s = Math.sin(a);
        return new Float32Array([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]);
    }

    scaleM(x, y, z) {
        return new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]);
    }
}

window.WebGL2AvatarRenderer = WebGL2AvatarRenderer;

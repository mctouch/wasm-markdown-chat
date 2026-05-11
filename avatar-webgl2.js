/* eslint-disable no-unused-vars */
// WebGL2 Fallback Renderer for Avatar Platform
// Draws multiple per-primitive draw calls from the GLB face mesh with morph blendshapes.
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
        if (!gl) throw new Error('WebGL2 not available');
        this.gl = gl;

        this.morphWeights  = new Float32Array(52);
        this.blendshapeNames = [];
        this.camera = { eye: [0, 24, 10], center: [0, 24, 0], up: [0, 1, 0] };
        this.modelBounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
        this.rotation = 0;
        this.time = 0;

        // Per-primitive draw calls (face + hair + body)
        this.drawList = [];
    }

    async loadModel(url) {
        const buf = await (await fetch(url)).arrayBuffer();
        const data = new Uint8Array(buf);
        const glb = this._parseGLB(data);
        this._buildDrawList(glb);
        this._centerCamera();
    }

    _parseGLB(data) {
        const dv = new DataView(data.buffer, data.byteOffset, 12);
        if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('Not a GLB file');
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

    // Fetch typed array from accessor
    _accView({ json, bin }, accessorIndex) {
        const acc = json.accessors[accessorIndex];
        const bv  = json.bufferViews[acc.bufferView];
        const off = (bv.byteOffset || 0) + (acc.byteOffset || 0);
        const len = acc.count;
        const b = bin.buffer; // underlying buffer
        const bo = bin.byteOffset;
        switch (acc.componentType) {
            case 5126: return { type: 'float32', view: new Float32Array(b, bo + off, len * 3), count: len, target: acc.type };
            case 5123: return { type: 'uint16',  view: new Uint16Array(b, bo + off, len),   count: len };
            case 5125: return { type: 'uint32',  view: new Uint32Array(b, bo + off, len),   count: len };
        }
        throw new Error('Unknown accessor type: ' + acc.componentType);
    }

    _buildDrawList({ json, bin }) {
        const gl = this.gl;
        // Create a single reusable material-color shader
        const vsSource = [
            '#version 300 es',
            'precision highp float;',
            'layout(location = 0) in vec3 aPos;',
            'layout(location = 1) in vec3 aNorm;',
            'uniform mat4 uMV, uP;',
            'uniform mat3 uN;',
            'out vec3 vN, vP;',
            'void main(){',
            '    vec4 mv = uMV * vec4(aPos, 1.0);',
            '    gl_Position = uP * mv;',
            '    vN = normalize(uN * aNorm);',
            '    vP = aPos;',
            '}'
        ].join('\n');

        const fsSource = [
            '#version 300 es',
            'precision highp float;',
            'in vec3 vN, vP;',
            'out vec4 oCol;',
            'uniform vec3 uBaseColor;',
            'void main(){',
            '    vec3 L = normalize(vec3(0.5, 1.0, 0.5));',
            '    float diff = max(dot(normalize(vN), L), 0.0);',
            '    float amb = 0.85;',
            '    vec3 col = uBaseColor * (amb + diff * 0.35);',
            '    float rim = 1.0 - max(dot(normalize(-vP), normalize(vN)), 0.0);',
            '    col += vec3(0.3, 0.4, 0.5) * pow(rim, 3.0) * 0.25;',
            '    oCol = vec4(col, 1.0);',
            '}'
        ].join('\n');
        this.prog = this._compile(vsSource, fsSource);
        this.uloc = {
            mv: gl.getUniformLocation(this.prog, 'uMV'),
            p:  gl.getUniformLocation(this.prog, 'uP'),
            n:  gl.getUniformLocation(this.prog, 'uN'),
            bc: gl.getUniformLocation(this.prog, 'uBaseColor')
        };

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

            // Shared positions / normals for all face prims
            const posInfo0 = this._accView({ json, bin }, faceMesh.primitives[0].attributes.POSITION);
            const faceVerts = posInfo0.count;
            const facePositions = new Float32Array(posInfo0.view);
            const normInfo0 = this._accView({ json, bin }, faceMesh.primitives[0].attributes.NORMAL);
            const faceNormals = new Float32Array(normInfo0.view);

            //bounds
            for (let i=0;i<faceVerts;i++){
                const x=facePositions[i*3], y=facePositions[i*3+1], z=facePositions[i*3+2];
                if(x<this.modelBounds.min[0]) this.modelBounds.min[0]=x;
                if(y<this.modelBounds.min[1]) this.modelBounds.min[1]=y;
                if(z<this.modelBounds.min[2]) this.modelBounds.min[2]=z;
                if(x>this.modelBounds.max[0]) this.modelBounds.max[0]=x;
                if(y>this.modelBounds.max[1]) this.modelBounds.max[1]=y;
                if(z>this.modelBounds.max[2]) this.modelBounds.max[2]=z;
            }

            // morph targets (deltas), shared across primitives
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

            // For each primitive in the face mesh, create a draw entry
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

                const vao = gl.createVertexArray();
                gl.bindVertexArray(vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.facePosBuf);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
                gl.bindBuffer(gl.ARRAY_BUFFER, this.faceNormBuf);
                gl.enableVertexAttribArray(1);
                gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
                if (idxBuf) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
                gl.bindVertexArray(null);
                // Guess material type by primitive characteristics
                let baseColor = [0.82, 0.62, 0.52]; // default skin
                if (prim.material !== undefined && json.materials && json.materials[prim.material]) {
                    const mat = json.materials[prim.material];
                    if (mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorFactor) {
                        baseColor = mat.pbrMetallicRoughness.baseColorFactor.slice(0, 3);
                    }
                }
                // Heuristic: if baseColor is white, use primitive size to guess type
                if (baseColor[0] > 0.99 && baseColor[1] > 0.99 && baseColor[2] > 0.99) {
                    if (indexCount < 1000) baseColor = [0.7, 0.1, 0.1]; // small = lips/inner mouth (reddish)
                    else if (indexCount > 8000) baseColor = [0.82, 0.62, 0.52]; // large = main face skin
                    else baseColor = [0.92, 0.92, 0.95]; // medium = eye white
                }

                this.drawList.push({
                    isFace: true,
                    vao,
                    posBuf: this.facePosBuf,
                    normBuf: this.faceNormBuf,
                    idxBuf,
                    indexCount,
                    idxType,
                    baseColor,
                    hasMorphs: true
                });
            }

            this.sharedMorph = { positions: facePositions, normals: faceNormals, morphTargets, count: faceVerts };
        }

        // --- 2. Process static meshes (hair, body, eyes — no morphs) ---
        for (const mesh of json.meshes || []) {
            const hasMorphs = mesh.primitives.some(p => p.targets && p.targets.length > 0);
            if (hasMorphs) continue; // skip, already handled

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

                const vao = gl.createVertexArray();
                gl.bindVertexArray(vao);
                gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
                gl.enableVertexAttribArray(0);
                gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
                gl.bindBuffer(gl.ARRAY_BUFFER, normBuf);
                gl.enableVertexAttribArray(1);
                gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
                if (idxBuf) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
                gl.bindVertexArray(null);

                let baseColor = [0.15, 0.10, 0.06]; // hair default
                const mName = (mesh.name || '').toLowerCase();
                if (mName.includes('body')) baseColor = [0.20, 0.15, 0.12];
                else if (mName.includes('eye')) baseColor = [0.9, 0.9, 0.95];
                if (prim.material !== undefined && json.materials && json.materials[prim.material]) {
                    const pbr = json.materials[prim.material].pbrMetallicRoughness;
                    if (pbr && pbr.baseColorFactor) baseColor = pbr.baseColorFactor.slice(0,3);
                }

                this.drawList.push({
                    isFace: false,
                    vao, posBuf, normBuf, idxBuf,
                    indexCount, idxType, baseColor,
                    hasMorphs: false
                });
            }
        }

        // Set initial aspect
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
        for (let i = 0; i < this.morphTargetCount && i < 52; i++) {
            const name = this.blendshapeNames[i];
            this.morphWeights[i] = (name && weights[name] !== undefined) ? weights[name] : 0;
        }
    }

    setBlendshapesArray(arr) {
        const len = Math.min(this.morphTargetCount || 0, 52, arr.length);
        for (let i = 0; i < len; i++) this.morphWeights[i] = arr[i];
        for (let i = len; i < 52; i++) this.morphWeights[i] = 0;
    }

    resize(w, h) {
        const canvas = this.canvas;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
        this.gl.viewport(0, 0, canvas.width, canvas.height);
        this.aspect = w / (h || 1);
    }

    render(dt) {
        const gl = this.gl;
        this.time += dt || 0.016;

        // Apply morph and upload face vertices
        if (this.sharedMorph) {
            const { positions: basePos, normals: baseNorm, morphTargets, count } = this.sharedMorph;
            this.workPositions.set(basePos);
            this.workNormals.set(baseNorm);

            for (let t = 0; t < Math.min(morphTargets.length, this.morphWeights.length); t++) {
                const w = this.morphWeights[t];
                if (Math.abs(w) < 0.0001) continue;
                const deltas = morphTargets[t];
                for (let i = 0; i < count * 3; i++) {
                    this.workPositions[i] += deltas[i] * w;
                }
            }

            gl.bindBuffer(gl.ARRAY_BUFFER, this.facePosBuf);
            gl.bufferData(gl.ARRAY_BUFFER, this.workPositions, gl.DYNAMIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.faceNormBuf);
            gl.bufferData(gl.ARRAY_BUFFER, this.workNormals, gl.DYNAMIC_DRAW);
        }

        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.useProgram(this.prog);

        // Camera
        const view = this.lookAt(this.camera.eye, this.camera.center, this.camera.up);
        const proj = this.perspective(45 * Math.PI / 180, this.aspect, 0.1, 100);
        const model = this.multiply(this.rotateY(Math.PI), this.scaleM(16, 16, 16));
        const mv = this.multiply(view, model); // standard OpenGL: view * model
        const nm = this.normalMatrix(mv);

        gl.uniformMatrix4fv(this.uloc.p, true, proj);
        gl.uniformMatrix4fv(this.uloc.mv, true, mv);
        gl.uniformMatrix3fv(this.uloc.n, true, nm);
        gl.uniform3f(this.uloc.bc, 1, 1, 1);

        // Draw all primitives
        for (const d of this.drawList) {
            gl.uniform3f(this.uloc.bc, d.baseColor[0], d.baseColor[1], d.baseColor[2]);
            gl.bindVertexArray(d.vao);
            if (d.idxBuf) {
                gl.drawElements(gl.TRIANGLES, d.indexCount, d.idxType, 0);
            } else {
                gl.drawArrays(gl.TRIANGLES, 0, d.indexCount);
            }
        }
    }

    lookAt(e, c, u) {
        const z = this.normalize([e[0]-c[0], e[1]-c[1], e[2]-c[2]]);
        const x = this.normalize(this.cross(u, z));
        const y = this.cross(z, x);
        return new Float32Array([
            x[0], y[0], z[0], 0,
            x[1], y[1], z[1], 0,
            x[2], y[2], z[2], 0,
            -this.dot(x,e), -this.dot(y,e), -this.dot(z,e), 1
        ]);
    }
    perspective(fov, aspect, near, far) {
        const f = 1.0 / Math.tan(fov / 2);
        const nf = 1 / (near - far);
        return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
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

    _centerCamera() {
        const b = this.modelBounds;
        const sx = 16.0, sy = 16.0, sz = 16.0;
        const cx = (b.min[0] + b.max[0]) * sx / 2;
        const cy = b.min[1] * sy + (b.max[1] - b.min[1]) * sy * 0.58;
        const cz = (b.min[2] + b.max[2]) * sz / 2;
        const dist = Math.max(8, (b.max[1] - b.min[1]) * sy * 0.22);
        this.camera.eye = [cx, cy, cz + dist];
        this.camera.center = [cx, cy, cz];
    }
}

window.WebGL2AvatarRenderer = WebGL2AvatarRenderer;

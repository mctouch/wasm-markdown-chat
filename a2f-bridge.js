/** A2F-3D Browser Bridge: microphone -> proxy -> blendshape frames -> avatar */
class A2FBridge {
    constructor(opts) {
        this.proxyUrl = opts.proxyUrl || 'http://localhost:8100/v1/audio2face/stream';
        this.onBlendshapes = opts.onBlendshapes || (() => {});
        this.onStatus = opts.onStatus || (() => {});
        this.onError = opts.onError || (() => {});
        this.onDone = opts.onDone || (() => {});

        this.audioCtx = null;
        this.processor = null;
        this.source = null;
        this.stream = null;
        this.pcmBuffer = [];
        this.isRecording = false;
    }

    async startRecording() {
        if (this.isRecording) return;
        this.isRecording = true;
        this.pcmBuffer = [];
        this.onStatus('Recording...');

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.audioCtx = new AudioContext({ sampleRate: 16000 });
            this.source = this.audioCtx.createMediaStreamSource(this.stream);
            this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);

            this.processor.onaudioprocess = (e) => {
                if (!this.isRecording) return;
                const data = e.inputBuffer.getChannelData(0);
                for (let i = 0; i < data.length; i++) {
                    this.pcmBuffer.push(data[i]);
                }
            };

            this.source.connect(this.processor);
            this.processor.connect(this.audioCtx.destination);
        } catch (err) {
            this.isRecording = false;
            this.onError('Mic error: ' + err.message);
        }
    }

    async stopRecording() {
        if (!this.isRecording) return;
        this.isRecording = false;
        this.onStatus('Processing...');

        if (this.processor) {
            this.processor.disconnect();
            this.processor.onaudioprocess = null;
        }
        if (this.source) this.source.disconnect();
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
        }
        if (this.audioCtx) {
            await this.audioCtx.close();
        }

        const floatSamples = new Float32Array(this.pcmBuffer);
        if (floatSamples.length < 1600) {
            this.onStatus('Too short');
            this.onDone();
            return;
        }
        await this._sendToA2F(floatSamples);
    }

    async test() {
        // Generate 1.5s synthetic sine wave at 440Hz, 16kHz mono 16-bit
        this.onStatus('Testing A2F with synthetic audio...');
        const duration = 1.5;
        const sampleRate = 16000;
        const totalSamples = Math.floor(duration * sampleRate);
        const floatSamples = new Float32Array(totalSamples);
        for (let i = 0; i < totalSamples; i++) {
            floatSamples[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * 0.5;
        }
        await this._sendToA2F(floatSamples);
    }

    async _sendToA2F(floatSamples) {
        // Convert Float32 -> Int16 little-endian bytes
        const rawBytes = new Uint8Array(floatSamples.length * 2);
        const view = new DataView(rawBytes.buffer);
        for (let i = 0; i < floatSamples.length; i++) {
            const s = Math.max(-1, Math.min(1, floatSamples[i]));
            const int16 = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
            view.setInt16(i * 2, int16, true);
        }

        try {
            const resp = await fetch(this.proxyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: rawBytes
            });
            if (!resp.ok) {
                const text = await resp.text();
                throw new Error(`HTTP ${resp.status}: ${text}`);
            }

            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let leftover = '';
            const frames = [];

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                leftover += decoder.decode(value, { stream: true });
                const lines = leftover.split('\n');
                leftover = lines.pop();
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const frame = JSON.parse(line);
                        if (frame.blendshapes) {
                            frames.push(frame.blendshapes);
                        } else if (frame.error) {
                            this.onError('A2F error: ' + frame.error);
                        }
                    } catch (e) {
                        // ignore parse errors
                    }
                }
            }

            this.onStatus(`Got ${frames.length} frames`);
            if (frames.length > 0) {
                this._playbackFrames(frames);
            } else {
                this.onDone();
            }
        } catch (err) {
            this.onError('Fetch error: ' + err.message);
            this.onStatus('A2F failed');
            this.onDone();
        }
    }

    _playbackFrames(frames) {
        let idx = 0;
        const interval = setInterval(() => {
            if (idx >= frames.length) {
                clearInterval(interval);
                window.currentA2FWeights = null;
                this.onStatus('');
                this.onDone();
                return;
            }
            this.onBlendshapes(frames[idx]);
            idx++;
        }, 33);
    }
}

window.A2FBridge = A2FBridge;

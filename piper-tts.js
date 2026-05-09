// piper-tts.js — Browser-local Piper TTS via ONNX Runtime Web
// Uses the rhasspy/piper-voices ONNX model directly (no C++ compile).
//
(function() {
"use strict";
// Usage:
//   const tts = new PiperTTS('./piper-voices/en_US-lessac-medium.onnx',
//                            './piper-voices/en_US-lessac-medium.onnx.json');
//   await tts.load();
//   const { audioBuffer, phonemeEvents } = await tts.synthesize('Hello world');
//
// Returns { audioBuffer: AudioBuffer, phonemeEvents: [{phoneme, startTime, duration}] }
// phonemeEvents can be fed to VisemeAnimator for lip-sync.

const ort = window.ort;
if (!ort) throw new Error('onnxruntime-web not loaded. Load ort.min.js before piper-tts.js');

/* ========================================================================== */
/* 1.  Minimal CMU-style pronunciation dictionary (ARPABET → text)           */
/* ========================================================================== */
const CMU_DICT = {
  // Vowels
  'a':     'AA',  'aa':    'AE',  'aah':   'AAH', 'ah':    'AH',
  'ae':    'AE',  'ao':    'AO',  'aw':    'AW',  'ay':    'AY',
  'e':     'IY',  'ee':    'IY',  'eh':    'EH',  'er':    'ER',
  'ey':    'EY',  'ih':    'IH',  'iy':    'IY', 'oe':    'AO',
  'oi':    'OY',  'oo':    'UW',  'ow':    'OW',  'oy':    'OY',
  'uh':    'UH',  'uw':    'UW',  'yuh':   'YUW',
  // Schwa
  'uhh':   'AH',  'ax': 'AH',  'axr': 'ER',  'ix': 'IH',
  // Consonants
  'b':     'B',   'ch':    'CH',  'd':     'D',   'dh':    'DH',
  'f':     'F',   'g':     'G',   'hh':    'HH',  'j':     'JH',
  'jh':    'JH',  'k':     'K',   'l':     'L',   'm':     'M',
  'n':     'N',   'ng':    'NG',  'p':     'P',   'r':     'R',
  'rh':    'R',   's':     'S',   'sh':    'SH',  'th':    'TH',
  't':     'T',   'v':     'V',   'w':     'W',   'wh':    'WH',
  'y':     'Y',   'z':     'Z',   'zh':    'ZH',
};

/* Common words → approximate ARPABET-like mapping for lightweight coverage */
const COMMON_WORDS = {
  'the':    'DH AH',
  'a':      'AH',
  'an':     'AE N',
  'and':    'AE N D',
  'are':    'AA R',
  'as':     'AE Z',
  'at':     'AE T',
  'be':     'B IY',
  'been':   'B IY N',
  'but':    'B AH T',
  'by':     'B AY',
  'can':    'K AE N',
  'could':  'K UH D',
  'do':     'D UH',
  'does':   'DAH Z',
  'for':    'F ER',
  'from':   'F R AH M',
  'had':    'H AE D',
  'has':    'H AE Z',
  'have':   'H AE V',
  'he':     'HH IY',
  'her':    'HH ER',
  'his':    'HH IZ',
  'how':    'HH AW',
  'i':      'AY',
  'in':     'IH N',
  'is':     'IH Z',
  'it':     'IH T',
  'just':   'JH AH S T',
  'know':   'N OW',
  'me':     'M IY',
  'my':     'M AY',
  'not':    'N AA T',
  'of':     'AH V',
  'on':     'AA N',
  'or':     'ER',
  'our':    'AW R',
  'said':   'S EH D',
  'she':    'SH IY',
  'so':     'S OW',
  'some':   'S AH M',
  'than':   'DH AE N',
  'that':   'DH AE T',
  'the':    'DH AH',
  'their':  'DHEH R',
  'them':   'DHEH M',
  'then':   'DH EH N',
  'there':  'DHEH R',
  'this':   'DH IZ',
  'to':     'T UH',
  'us':     'AH S',
  'was':    'W AA Z',
  'we':     'W IY',
  'what':   'W AA T',
  'when':   'W EH N',
  'which':  'W IH CH',
  'who':    'HH UH',
  'will':   'W IY L',
  'with':   'W IY DH',
  'would':  'W UH D',
  'you':    'Y UH',
  'your':   'Y ER',
  'hello':  'HH AH L OW',
  'world':  'W ER L D',
  'good':   'G UH D',
  'morning':'M ER N IH NG',
  'night':  'N AY T',
  'please': 'P L IY Z',
  'thank':  'TH AE NG K',
  'thanks': 'TH AE NG S',
  'yes':    'Y EH S',
  'no':     'N OW',
  'ok':     'O KEH',
  'okay':   'O KEH',
  'welcome':'W EH L K AH M',
  'my':     'M AY',
  'name':   'N EY M',
  'is':     'IH Z',
  'am':     'AE M',
  'here':   'HH IY R',
  'today':  'T AH D EY',
  'tomorrow':'T AH M AA R OW',
  'yesterday':'Y EH S T EH D EY',
  'time':   'T AY M',
  'day':    'D EY',
  'way':    'W EY',
  'very':   'V EH R IY',
  'much':   'M AH CH',
  'like':   'L AY K',
};

/* ========================================================================== */
/* 2.  ARPABET → IPA phoneme conversion (Piper expects IPA/espeak style)     */
/* ========================================================================== */
const ARPABET_TO_IPA = {
  'AA': 'ɑ',     'AE': 'æ',     'AH': 'ʌ',       'AO': 'ɔ',
  'AW': 'aʊ',    'AY': 'aɪ',    'B':  'b',       'CH': 'tʃ',
  'D':  'd',     'DH': 'ð',     'EH': 'ɛ',       'ER': 'ɚ',
  'EY': 'eɪ',    'F':  'f',     'G':  'ɡ',       'HH': 'h',
  'IH': 'ɪ',     'IY': 'i',     'JH': 'dʒ',      'K':  'k',
  'L':  'l',     'M':  'm',     'N':  'n',       'NG': 'ŋ',
  'OW': 'oʊ',    'OY': 'ɔɪ',    'P':  'p',       'R':  'ɹ',
  'S':  's',     'SH': 'ʃ',     'T':  't',       'TH': 'θ',
  'UH': 'ʊ',     'UW': 'u',     'V':  'v',       'W':  'w',
  'WH': 'ʍ',     'Y':  'j',     'Z':  'z',       'ZH': 'ʒ',
};

/* ========================================================================== */
/* 3.  Simple letter-to-ARPABET fallback (heuristic)                         */
/* ========================================================================== */
function graphemesToArpabet(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return [];

  // Try common words first
  if (COMMON_WORDS[word]) return COMMON_WORDS[word].split(' ');

  // Heuristic letter-to-sound rules
  const result = [];
  let i = 0;
  while (i < word.length) {
    let matched = false;

    // Try digraphs first
    if (i + 1 < word.length) {
      const digraph = word[i] + word[i + 1];
      if (digraph in CMU_DICT) {
        result.push(CMU_DICT[digraph]);
        i += 2;
        matched = true;
      }
      // Special vowel patterns
      if (!matched && digraph === 'ai') { result.push('EY'); i += 2; matched = true; }
      if (!matched && digraph === 'ea') { result.push('IY'); i += 2; matched = true; }
      if (!matched && digraph === 'oi') { result.push('OY'); i += 2; matched = true; }
      if (!matched && digraph === 'ou') { result.push('AW'); i += 2; matched = true; }
      if (!matched && digraph === 'oi') { result.push('OY'); i += 2; matched = true; }
      if (!matched && digraph === 'th') { result.push('TH'); i += 2; matched = true; }
      if (!matched && digraph === 'ph') { result.push('F'); i += 2; matched = true; }
      if (!matched && digraph === 'sh') { result.push('SH'); i += 2; matched = true; }
      if (!matched && digraph === 'ch') { result.push('CH'); i += 2; matched = true; }
      if (!matched && digraph === 'ng') { result.push('NG'); i += 2; matched = true; }
      if (!matched && digraph === 'wh') { result.push('WH'); i += 2; matched = true; }
      // magic E pattern: Vowel + Consonant + E
      if (!matched && i + 2 < word.length && word[i + 2] === 'e' && i === word.length - 3) {
        const vowelMap = { 'a': 'EY', 'i': 'AY', 'o': 'OW', 'u': 'YUW' };
        if (vowelMap[word[i]]) {
          result.push(vowelMap[word[i]]);
          // Consonant
          result.push(CMU_DICT[word[i + 1]] || word[i + 1].toUpperCase());
          i += 3;
          matched = true;
        }
      }
    }
    if (!matched) {
      const c = word[i];
      if (c in CMU_DICT) {
        result.push(CMU_DICT[c]);
      } else {
        // Fallback to uppercase letter
        result.push(c.toUpperCase());
      }
      i++;
    }
  }
  return result;
}

/* ========================================================================== */
/* 4.  Text → espeak phoneme sequence (minimal espeak approximation)          */
/* ========================================================================== */

// Common words → espeak phoneme strings (using chars available in phoneme_id_map)
const ESPEAK_WORDS = {
  'the': 'ðə', 'a': 'ə', 'an': 'æn', 'and': 'ænd', 'are': 'ɑr',
  'as': 'æz', 'at': 'æt', 'be': 'bi', 'been': 'bɪn', 'but': 'bʌt',
  'by': 'baɪ', 'can': 'kæn', 'could': 'kʊd', 'do': 'du', 'does': 'dʌz',
  'for': 'fɔr', 'from': 'frʌm', 'had': 'hæd', 'has': 'hæz', 'have': 'hæv',
  'he': 'hi', 'her': 'hɚ', 'his': 'hɪz', 'how': 'haʊ', 'i': 'aɪ',
  'in': 'ɪn', 'is': 'ɪz', 'it': 'ɪt', 'just': 'dʒʌst', 'know': 'noʊ',
  'me': 'mi', 'my': 'maɪ', 'not': 'nɑt', 'of': 'ʌv', 'on': 'ɑn',
  'or': 'ɔr', 'our': 'aʊɚ', 'said': 'sɛd', 'she': 'ʃi', 'so': 'soʊ',
  'some': 'sʌm', 'than': 'ðæn', 'that': 'ðæt', 'their': 'ðɛr', 'them': 'ðɛm',
  'then': 'ðɛn', 'there': 'ðɛr', 'this': 'ðɪs', 'to': 'tu', 'too': 'tu',
  'us': 'ʌs', 'was': 'wʌz', 'we': 'wi', 'what': 'wʌt', 'when': 'wɛn',
  'which': 'wɪtʃ', 'who': 'hu', 'will': 'wɪl', 'with': 'wɪð', 'would': 'wʊd',
  'you': 'ju', 'your': 'jɔr', 'hello': 'həloʊ', 'world': 'wɚld',
  'good': 'gʊd', 'morning': 'mɔrnɪŋ', 'night': 'naɪt', 'please': 'pliz',
  'thank': 'θæŋk', 'thanks': 'θæŋks', 'yes': 'jɛs', 'no': 'noʊ',
  'ok': 'oʊkeɪ', 'okay': 'oʊkeɪ', 'welcome': 'wɛlkʌm', 'name': 'neɪm',
  'am': 'æm', 'here': 'hɪr', 'today': 'tədeɪ', 'tomorrow': 'təmɑroʊ',
  'yesterday': 'jɛstɚdeɪ', 'time': 'taɪm', 'day': 'deɪ', 'way': 'weɪ',
  'very': 'vɛri', 'much': 'mʌtʃ', 'like': 'laɪk', 'whisper': 'wɪspɚ',
  'wind': 'wɪnd', 'speak': 'spik', 'short': 'ʃɔrt', 'poem': 'poʊəm',
  'sky': 'skaɪ', 'blue': 'blu', 'star': 'stɑr', 'stars': 'stɑrz',
  'night': 'naɪt', 'see': 'si', 'look': 'lʊk', 'at': 'æt', 'up': 'ʌp',
};

// Simple letter → espeak phoneme mapping (per-character fallback)
const LETTER_TO_PHONEME = {
  'a': 'æ', 'e': 'ɛ', 'i': 'ɪ', 'o': 'ɒ', 'u': 'ʌ',
  'b': 'b', 'c': 'k', 'd': 'd', 'f': 'f', 'g': 'g',
  'h': 'h', 'j': 'dʒ', 'k': 'k', 'l': 'l', 'm': 'm',
  'n': 'n', 'p': 'p', 'q': 'k', 'r': 'ɹ', 's': 's',
  't': 't', 'v': 'v', 'w': 'w', 'x': 'ks', 'y': 'j', 'z': 'z',
};

function textToPhonemes(text, phonemeIdMap) {
  const phonemes = [];
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 0);
  
  for (let wi = 0; wi < words.length; wi++) {
    const word = words[wi].replace(/[^a-z]/g, '');
    if (!word) continue;
    
    // Try exact word match
    if (ESPEAK_WORDS[word]) {
      for (const ch of ESPEAK_WORDS[word]) {
        if (phonemeIdMap[ch] !== undefined) phonemes.push(ch);
      }
    } else {
      // Per-letter fallback
      for (const c of word) {
        const pm = LETTER_TO_PHONEME[c];
        if (pm) {
          for (const ch of pm) {
            if (phonemeIdMap[ch] !== undefined) phonemes.push(ch);
          }
        }
      }
    }
    
    // Word separator (space between words)
    if (wi < words.length - 1 && phonemeIdMap[' '] !== undefined) {
      phonemes.push(' ');
    }
  }
  return phonemes;
}

/* ========================================================================== */
/* 5.  IPA → Piper phoneme IDs                                               */
/* ========================================================================== */
function phonemesToIds(ipaPhonemes, phonemeIdMap) {
  const ids = [];
  let phonemeNames = [];

  // Start with _ (silence/pause marker) as Piper does
  ids.push(phonemeIdMap['^'] ? phonemeIdMap['^'][0] : 1);

  for (const ch of ipaPhonemes) {
    if (phonemeIdMap[ch]) {
      ids.push(phonemeIdMap[ch][0]);
      phonemeNames.push(ch);
    } else {
      // Try lowercase
      const lower = ch.toLowerCase();
      if (phonemeIdMap[lower]) {
        ids.push(phonemeIdMap[lower][0]);
        phonemeNames.push(lower);
      } else {
        // Skip unknown characters
        phonemeNames.push(ch); // keep for mapping
        ids.push(phonemeIdMap[' '] ? phonemeIdMap[' '][0] : 3);
      }
    }
  }

  // End with ^ (sentence end)
  ids.push(phonemeIdMap['$'] ? phonemeIdMap['$'][0] : 2);
  phonemeNames.push('$');

  return { ids, phonemeNames };
}

/* ========================================================================== */
/* 6.  ARPABET → Viseme mapping for phonemeEvents                            */
/* ========================================================================== */
const ARPABET_TO_VISeme = {
  'AA': 'AAH',    'AE': 'AAH',    'AH': 'AAH',     'AO': 'OH',
  'AW': 'AAH',    'AY': 'AAH',    'B':  'MBP',     'CH': 'CH',
  'D':  'D',      'DH': 'TH',     'EH': 'EE',      'ER': 'R',
  'EY': 'EE',     'F':  'FV',     'G':  'G',       'HH': 'AAH',
  'IH': 'IH',     'IY': 'EE',     'JH': 'CH',      'K':  'K',
  'L':  'L',      'M':  'MBP',    'N':  'N',       'NG': 'N',
  'OW': 'OH',     'OY': 'OH',     'P':  'MBP',     'R':  'R',
  'S':  'S',      'SH': 'SH',     'T':  'T',       'TH': 'L',
  'UH': 'OOH',    'UW': 'OOH',    'V':  'FV',      'W':  'W',
  'WH': 'W',      'Y':  'EE',     'Z':  'S',       'ZH': 'SH',
};

function arpabetToViseme(arpabet) {
  return ARPABET_TO_VISeme[arpabet] || 'REST';
}

/* ========================================================================== */
/* 7.  PiperTTS class                                                       */
/* ========================================================================== */
class PiperTTS {
  /**
   * @param {string} onnxPath – URL/path to the .onnx model file
   * @param {string} configPath – URL/path to the .onnx.json config file
   */
  constructor(onnxPath, configPath) {
    this.onnxPath = onnxPath;
    this.configPath = configPath;
    this.session = null;
    this.config = null;
    this.phonemeIdMap = null;
    this.sampleRate = 22050;
    this.noiseScale = 0.667;
    this.lengthScale = 1.0;
    this.noiseW = 0.8;
  }

  /**
   * Load the ONNX model and config. Must be called before synthesize().
   */
  async load() {
    // Load config
    const configResp = await fetch(this.configPath);
    if (!configResp.ok) {
      throw new Error(`Failed to load config from ${this.configPath}: ${configResp.status}`);
    }
    this.config = await configResp.json();

    // Extract config values
    this.phonemeIdMap = this.config.phoneme_id_map || {};
    this.sampleRate = this.config.audio?.sample_rate || 22050;

    if (this.config.inference) {
      this.noiseScale = this.config.inference.noise_scale ?? 0.667;
      this.lengthScale = this.config.inference.length_scale ?? 1.0;
      this.noiseW = this.config.inference.noise_w ?? 0.8;
    }

    // Create ONNX session with WASM backend
    this.session = await ort.InferenceSession.create(this.onnxPath, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    console.log(`[PiperTTS] Model loaded. Inputs: ${this.session.inputNames.join(', ')} | Outputs: ${this.session.outputNames.join(', ')}`);
    this.loaded = true;
  }

  /**
   * Synthesize text to speech.
   * @param {string} text – The text to speak.
   * @returns {{ audioBuffer: AudioBuffer, phonemeEvents: Array<{phoneme: string, startTime: number, duration: number, viseme: string}> }}
   */
  async synthesize(text) {
    if (!this.session) {
      throw new Error('PiperTTS not loaded. Call load() first.');
    }

    // 1. Phonemize text using espeak character-level fallback
    const phonemes = textToPhonemes(text, this.phonemeIdMap);
    const { ids: phonemeIds, phonemeNames } = phonemesToIds(phonemes, this.phonemeIdMap);

    if (phonemeIds.length === 0) {
      throw new Error('No phonemes extracted from text');
    }

    // 2. Prepare ONNX input tensors
    //    input: int64[1, seq_len] – phoneme IDs
    //    input_lengths: int64[1] – sequence length
    //    scales: float32[3] – [noise_scale, length_scale, noise_w]

    const seqLen = phonemeIds.length;

    // Use BigInt for int64 tensors (ONNX requires BigInt for int64)
    const inputArray = new BigInt64Array(seqLen);
    for (let i = 0; i < seqLen; i++) {
      inputArray[i] = BigInt(phonemeIds[i]);
    }

    const inputTensor = new ort.Tensor('int64', inputArray, [1, seqLen]);
    const inputLengthsTensor = new ort.Tensor('int64', BigInt64Array.of(BigInt(seqLen)), [1]);
    const scalesTensor = new ort.Tensor('float32', Float32Array.of(
      this.noiseScale,
      this.lengthScale,
      this.noiseW
    ), [3]);

    // 3. Run inference
    const feeds = {
      input: inputTensor,
      input_lengths: inputLengthsTensor,
      scales: scalesTensor,
    };

    const results = await this.session.run(feeds);

    // 4. Extract audio output
    // Output tensor shape: [1, 1, num_samples] or [1, num_samples]
    const outputTensor = results.output;
    const audioData = outputTensor.data; // Float32Array
    const numSamples = outputTensor.dims.reduce((a, b) => a * b, 1);

    // Flatten to 1D Float32Array
    let samples;
    if (numSamples === audioData.length) {
      samples = audioData;
    } else {
      samples = new Float32Array(numSamples);
      samples.set(audioData);
    }

    // 5. Create Web Audio AudioBuffer
    const audioContext = new AudioContext({ sampleRate: this.sampleRate });
    const audioBuffer = audioContext.createBuffer(1, samples.length, this.sampleRate);
    audioBuffer.getChannelData(0).set(samples);

    // 6. Generate phonemeEvents with timing estimates
    const totalDuration = samples.length / this.sampleRate;
    const phonemeEvents = this._generatePhonemeEvents(totalDuration, phonemeNames, text);

    console.log(`[PiperTTS] Synthesized ${samples.length} samples (${(totalDuration * 1000).toFixed(0)}ms) for "${text}" → ${phonemeEvents.length} phoneme events`);

    return { audioBuffer, phonemeEvents };
  }

  /**
   * Generate phoneme events with estimated timings.
   * Distributes phonemes across the audio duration, giving more time to
   * vowels/long sounds and less to consonants. Short silences are inserted
   * between words.
   */
  _generatePhonemeEvents(totalDuration, phonemeNames, originalText) {
    if (totalDuration <= 0 || phonemeNames.length === 0) return [];

    const events = [];
    const numPhonemes = phonemeNames.length;

    // Average duration per phoneme
    const avgDuration = totalDuration / numPhonemes;

    // Assign weights: vowels get more time, consonants less
    const vowelPhonemes = new Set(['a', 'e', 'i', 'o', 'u', 'ɑ', 'æ', 'ʌ', 'ɔ', 'ɪ', 'ɛ', 'ə', 'ɚ', 'ʊ', 'ʉ', 'ʏ', 'ɨ', 'ʉ', 'i', 'e', 'o', 'y']);

    let currentTime = 0.0;

    for (let i = 0; i < phonemeNames.length; i++) {
      const phoneme = phonemeNames[i];

      // Duration weight based on phoneme type
      let weight = 1.0;
      if (vowelPhonemes.has(phoneme)) {
        weight = 1.4;
      } else if (phoneme === ' ') {
        weight = 0.5; // word boundary pause
      } else if ('ʃʒtʃdʒ'.includes(phoneme)) {
        weight = 1.2; // fricatives/affricates
      } else if ('bpɡkdtk'.includes(phoneme)) {
        weight = 0.6; // stops are fast
      } else if (phoneme === '$' || phoneme === '^') {
        weight = 0.3; // sentence boundaries
      }

      const duration = avgDuration * weight;

      const viseme = arpabetToViseme(this._ipaToArpabetApprox(phoneme));

      events.push({
        phoneme,
        startTime: currentTime,
        duration,
        viseme,
      });

      currentTime += duration;
    }

    // Normalize durations to match totalDuration exactly
    const scale = totalDuration / currentTime;
    currentTime = 0.0;
    for (const evt of events) {
      evt.startTime = currentTime;
      evt.duration = evt.duration * scale;
      currentTime += evt.duration;
    }

    return events;
  }

  /**
   * Approximate IPA character → ARPABET for viseme mapping.
   * This is a reverse mapping used only for phonemeEvents visualization.
   */
  _ipaToArpabetApprox(ipaChar) {
    const reverse = {};
    for (const [arp, ipa] of Object.entries(ARPABET_TO_IPA)) {
      reverse[ipa[0]] = arp; // first char of IPA string
    }
    return reverse[ipaChar] || null;
  }
}

window.PiperTTS = PiperTTS;
window.graphemesToArpabet = graphemesToArpabet;
window.arpabetToViseme = arpabetToViseme;
})();

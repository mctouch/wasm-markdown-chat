# Multilingual Support Plan: English + Chinese

## Overview
Add automatic locale detection + full i18n for English (`en`) and Simplified Chinese (`zh-CN`).
The app should detect browser language on first load, allow manual override, and persist choice.

---

## Phase 1: Locale Detection & State Management

### 1.1 Browser Language Detection
```javascript
// Priority: ?lang=zh param > localStorage > navigator.languages > navigator.language > 'en'
function detectLocale() {
    const urlParams = new URLSearchParams(window.location.search);
    const paramLang = urlParams.get('lang');
    if (paramLang && ['en', 'zh'].includes(paramLang)) return paramLang;
    
    const stored = localStorage.getItem('app_locale');
    if (stored) return stored;
    
    const browserLang = (navigator.languages?.[0] || navigator.language || 'en').toLowerCase();
    if (browserLang.startsWith('zh')) return 'zh';
    return 'en';
}
```

### 1.2 Locale State
- `window.__locale` — current active locale (`'en'` | `'zh'`)
- `localStorage.setItem('app_locale', locale)` — persist user choice
- Language switcher button in settings or input bar

---

## Phase 2: Translation Dictionary

### 2.1 Structure
Create `i18n.js` with a flat key-value dictionary:

```javascript
const I18N = {
    en: {
        appTitle: 'WASM WebGPU Markdown + AI Chat',
        apiKeyTitle: 'Enter Kimi API Key',
        apiKeyHint: 'Your API key is stored locally in your browser...',
        placeholderInput: 'Ask Kimi anything...',
        btnSend: 'Send',
        btnTalk: 'Talk',
        btnA2FTalk: 'A2F Talk',
        typing: 'Kimi is thinking...',
        voiceReady: 'Voice: Ready',
        tipHoldTalk: 'Hold the Talk button to speak your message...',
        timeIs: 'The time is',
        oclock: "o'clock",
    },
    zh: {
        appTitle: 'WebGPU 实时渲染 + AI 对话',
        apiKeyTitle: '请输入 Kimi API 密钥',
        apiKeyHint: '您的 API 密钥仅存储在浏览器本地...',
        placeholderInput: '向 Kimi 提问...',
        btnSend: '发送',
        btnTalk: '语音',
        btnA2FTalk: 'A2F 语音',
        typing: 'Kimi 正在思考...',
        voiceReady: '语音: 就绪',
        tipHoldTalk: '按住语音按钮说话，松开自动发送...',
        timeIs: '现在是',
        oclock: '点整',
    }
};

function t(key) { return I18N[window.__locale]?.[key] || I18N['en'][key]; }
```

### 2.2 UI Elements to Translate
- [ ] `title` tag
- [ ] API key overlay (title, hint, button)
- [ ] Input placeholder
- [ ] Send / Talk / A2F Talk buttons
- [ ] Typing indicator text
- [ ] Voice status text
- [ ] Settings button tooltip
- [ ] Scroll-to-bottom tooltip
- [ ] Proactive speech strings (time, thoughts, tips)
- [ ] Error messages (mic error, A2F failed, etc.)

---

## Phase 3: Chinese-Specific Layout Engine Changes

### 3.1 Word Wrapping for CJK Text
Chinese has no spaces between words. The current word-aware layout breaks CJK incorrectly.

**Fix in `layout.rs` `estimate_text_lines()`:**
```rust
fn estimate_text_lines(&self, spans: &[TextSpan], width: f32, font_size: f32) -> f32 {
    // Detect if text contains CJK characters
    let has_cjk = spans.iter().any(|s| s.text.chars().any(|c| {
        matches!(c as u32,
            0x4E00..=0x9FFF |   // CJK Unified
            0x3400..=0x4DBF |   // CJK Extension A
            0xF900..=0xFAFF |   // CJK Compatibility
            0x3000..=0x303F     // CJK Punctuation
        )
    }));
    
    if has_cjk {
        self.estimate_cjk_lines(spans, width, font_size)
    } else {
        self.estimate_word_lines(spans, width, font_size)
    }
}

fn estimate_cjk_lines(&self, spans: &[TextSpan], width: f32, font_size: f32) -> f32 {
    let char_width = font_size * 1.0; // CJK chars are roughly square at font size
    let mut line_count = 0.0;
    let mut current_width = 0.0;
    
    for span in spans {
        for ch in span.text.chars() {
            if ch == '\n' {
                line_count += 1.0;
                current_width = 0.0;
                continue;
            }
            let cw = if ch.is_ascii() { font_size * 0.5 } else { char_width };
            if current_width + cw > width && current_width > 0.0 {
                line_count += 1.0;
                current_width = cw;
            } else {
                current_width += cw;
            }
        }
    }
    if current_width > 0.0 || line_count == 0.0 { line_count += 1.0; }
    line_count.max(1.0)
}
```

### 3.2 Glyphon Text Buffer for CJK
- Glyphon supports CJK via `FontSystem` with multiple font families
- Add a CJK font to the font stack: `"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`
- Load `NotoSansSC-Regular.ttf` (~5MB) or subset to common chars

---

## Phase 4: TTS Voice Per Locale

### 4.1 Voice Mapping
| Locale | Default Voice | Fallback |
|--------|--------------|----------|
| `en`   | `en_US-amy-medium` | `en_US-lessac-medium` |
| `zh`   | `zh_CN-huayan-medium` | `zh_CN-lexi-medium` |

### 4.2 Piper Chinese Voices
Download from HuggingFace:
```bash
# Huayan (female Chinese)
wget https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx.json
```

### 4.3 Server TTS Endpoint Changes
```python
# piper_tts_server.py
VOICE_DEFAULTS = {
    'en': 'en_US-amy-medium',
    'zh': 'zh_CN-huayan-medium',
}

@app.route('/v1/tts/synthesize', methods=['POST'])
def synthesize():
    data = request.get_json() or {}
    text = data.get('text', '')
    locale = data.get('locale', 'en')
    voice = data.get('voice') or VOICE_DEFAULTS.get(locale, 'en_US-amy-medium')
    ...
```

### 4.4 Frontend Voice Selector
- When locale switches to `zh`, dropdown shows: "华艳 (中文女声)"
- When locale switches to `en`, dropdown shows: "Amy (Female)"

---

## Phase 5: ASR Language Per Locale

### 5.1 Web Speech API Language
```javascript
const recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
recognition.lang = window.__locale === 'zh' ? 'zh-CN' : 'en-US';
```

### 5.2 Interim Results Handling
- Chinese ASR may return characters without spaces — handle gracefully
- No change needed for display (glyphon renders CJK fine)

---

## Phase 6: Proactive Speech i18n

### 6.1 Time Announcements
```javascript
function announceTime() {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes();
    
    if (window.__locale === 'zh') {
        const h24 = hours;
        const mStr = minutes === 0 ? '整' : `${minutes}分`;
        speakText(`现在是${h24}点${mStr}。`);
    } else {
        // existing English format
    }
}
```

### 6.2 Thoughts & Tips (Chinese translations)
```javascript
const THOUGHTS_AND_TIPS_ZH = [
    "小贴士：按住语音按钮可以直接说话，不用打字。",
    "你知道吗？A2F 是 Audio to Face 的缩写，能把你的声音实时转成面部表情。",
    "小贴士：点击语音选择下拉框可以在华艳和 Amy 之间切换。",
    "小贴士：点击喇叭图标可以关闭或开启自动朗读回复。",
    "想法：人机交互的未来，不只是屏幕上的文字，而是能看、能听的存在。",
];
```

---

## Phase 7: Font Loading

### 7.1 Google Fonts (Noto Sans SC)
```html
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;600;700&display=swap" rel="stylesheet">
```

### 7.2 CSS Font Stack
```css
html, body {
    font-family: 'Fredoka', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', 'Comic Sans MS', cursive, sans-serif;
}
```
- Fredoka for Latin chars (English)
- Noto Sans SC for CJK fallback

### 7.3 Glyphon Font Registration
- Load both Fredoka and Noto Sans SC into glyphon's `FontSystem`
- Register as a font family list: `["Fredoka", "Noto Sans SC"]`

---

## Phase 8: Language Switcher UI

### 8.1 Placement
Add a globe icon button next to the settings button:
```html
<button id="lang-btn" title="Switch language">🌐</button>
```

### 8.2 Behavior
- Click cycles: `en` → `zh` → `en`
- Or show a dropdown: English | 简体中文
- Immediately re-render all static UI strings
- Send `locale` to TTS server with each request
- Persist to `localStorage`

---

## Phase 9: Markdown Parser i18n

### 9.1 No Changes Needed
- pulldown-cmark parses UTF-8 correctly
- CJK in headings, paragraphs, lists works out of the box
- Only layout engine needs CJK-aware wrapping (Phase 3)

---

## Phase 10: Testing Checklist

### 10.1 English Mode (`?lang=en`)
- [ ] All UI strings in English
- [ ] Amy voice by default
- [ ] ASR set to `en-US`
- [ ] Time announcement: "The time is 3 fifteen PM"
- [ ] Word-wrapping works for English text

### 10.2 Chinese Mode (`?lang=zh`)
- [ ] All UI strings in Chinese
- [ ] 华艳 voice by default
- [ ] ASR set to `zh-CN`
- [ ] Time announcement: "现在是15点整"
- [ ] Character-wrapping works for Chinese text (no mid-character splits)
- [ ] Mixed EN/CN text wraps correctly
- [ ] Chinese markdown renders without overlap

### 10.3 Auto-Detection
- [ ] Browser `zh-CN` → auto-loads Chinese
- [ ] Browser `en-US` → auto-loads English
- [ ] Manual override persists across reloads
- [ ] URL param `?lang=zh` overrides everything

---

## Phase 11: File Changes Summary

| File | Change |
|------|--------|
| `index.html` | Add language switcher, translate all static strings, load Noto Sans SC font |
| `i18n.js` (new) | Translation dictionary + `t()` helper + locale detection |
| `piper_tts_server.py` | Add `locale` param, voice defaults per locale, download zh voice |
| `src/markdown/layout.rs` | Add `estimate_cjk_lines()`, CJK character detection |
| `src/gpu/text_pipeline.rs` | Register Noto Sans SC as fallback font in glyphon |
| `src/theme/mod.rs` | Optionally adjust `font_size_base` for CJK readability (16px → 15px) |

---

## Estimated Effort
- **Phase 1-2** (i18n infra): 2h
- **Phase 3** (CJK layout): 3h
- **Phase 4** (Chinese TTS voice): 1h
- **Phase 5-6** (ASR + proactive speech i18n): 1h
- **Phase 7** (font loading): 1h
- **Phase 8** (language switcher UI): 1h
- **Phase 10** (testing): 2h

**Total: ~11 hours** (can parallelize TTS voice download with layout work)

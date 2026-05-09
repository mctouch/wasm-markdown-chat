# Architecture: WASM WebGPU Markdown + AI Chat Viewer

## Module Contracts

### markdown/parser.rs
- Input: `&str` (markdown source)
- Output: `MdDocument` (AST with elements)
- Must handle: paragraphs, headings (h1-h6), code blocks, inline code, images, tables, lists (ordered/unordered), task items, blockquotes, horizontal rules, links, bold/italic/strikethrough

### markdown/layout.rs  
- Input: `&mut MdDocument`, `viewport_width: f32`, `&Theme`
- Output: Sets `y_offset`, `width`, `height` on all `MdElement`s, sets `MdDocument.total_height`
- Uses `cosmic-text` Buffer for text measurement
- Flow layout: vertical stacking with margins

### markdown/renderer.rs
- Input: `&MdDocument`, `&mut wgpu::RenderPass`, `scroll_offset: f32`, `viewport: (f32, f32)`, `&Theme`, `&mut GpuContext`
- Renders all visible elements (culling off-screen)
- Delegates text to glyphon, rectangles to rect_pipeline, images to image_pipeline

### gpu/context.rs
- Owns `wgpu::Device`, `wgpu::Queue`, `wgpu::Surface`, `wgpu::SurfaceConfiguration`
- Provides `resize(width, height)`
- Provides `begin_frame() -> (wgpu::SurfaceTexture, wgpu::TextureView, wgpu::CommandEncoder)`
- Provides `submit(encoder)`

### gpu/text_pipeline.rs
- Wraps `glyphon::Renderer`
- Prepares and renders text areas from layout blocks

### gpu/rect_pipeline.rs
- Simple colored rectangle pipeline (WGSL shader)
- Draws code block backgrounds, table row alternation, horizontal rules, quote bars

### gpu/image_pipeline.rs
- Textured quad pipeline
- Uploads decoded images as wgpu textures
- Renders images at layout positions

### chat/kimi.rs
- `KimiClient` with conversation history
- `chat(user_input) -> Result<String>` non-streaming
- `chat_stream(user_input, on_chunk)` streaming via SSE
- History truncation (last 20 turns + system)
- WASM: uses `web_sys::fetch` or `gloo_net`
- Native: uses `reqwest`

### chat/stream.rs
- SSE parser for Kimi streaming responses
- Emits chunks as they arrive

### theme/mod.rs
- `Theme` struct with all colors, spacing, typography
- 10 presets: dark, light, catppuccin-latte, catppuccin-mocha, nord, dracula, solarized-dark, solarized-light, gruvbox-dark, tokyo-night
- `ThemeColor` with conversions to glyphon, wgpu, CSS

## Data Flow

```
User Input -> KimiClient -> Streaming Response
                    |
                    v
            Markdown String
                    |
                    v
            markdown::parser::parse_markdown()
                    |
                    v
            markdown::layout::LayoutEngine::layout()
                    |
                    v
            markdown::renderer::MarkdownRenderer::render()
                    |
                    v
            WebGPU Render Pass (text + rects + images)
                    |
                    v
            Canvas / Surface
```

## Build Commands

```bash
# WASM build
wasm-pack build --target web --out-dir pkg

# Native build
cargo run --bin wasm-markdown-chat-native

# Dev server
python3 -m http.server 8080
# open http://localhost:8080
```

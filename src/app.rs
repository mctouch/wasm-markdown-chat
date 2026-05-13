use crate::chat::kimi::KimiClient;
use crate::gpu::GpuContext;
use crate::markdown::{MdDocument, parser::parse_markdown, layout::LayoutEngine, renderer::MarkdownRenderer};
use crate::theme::Theme;
use std::sync::{Arc, Mutex};
use wasm_bindgen::prelude::*;

// Global streaming progress counter (separate from App to avoid mutex deadlocks)
static STREAMING_CHARS: Mutex<u32> = Mutex::new(0);
static STREAMING_ACTIVE: Mutex<bool> = Mutex::new(false);

pub struct App {
    pub gpu: Option<GpuContext>,
    pub document: Arc<Mutex<MdDocument>>,
    pub theme: Theme,
    pub renderer: Option<MarkdownRenderer>,
    pub scroll_offset: f32,
    pub viewport: (f32, f32),
    pub kimi: Option<KimiClient>,
    // Double-buffered staging buffers to avoid map/unmap race conditions
    pub staging_buffers: [Option<Arc<wgpu::Buffer>>; 2],
    pub staging_flip: usize,
    pub staging_dims: (u32, u32),
    pub staging_bpr: u32,
    pub auto_scroll: bool,
}

impl App {
    pub async fn new() -> Self {
        let theme = Theme::dark();
        let markdown = r#"# Welcome to WASM WebGPU Markdown Chat

This is a **real-time** markdown renderer built with **Rust + WebGPU**.

## Features
- Smooth GPU-accelerated scrolling
- Syntax-highlighted code blocks
- Image display
- Multi-turn AI chat via Kimi API

```rust
fn main() {
    println!("Hello, WebGPU!");
}
```

> This is a blockquote. The future of web rendering is here.

---

*Built by a multi-agent swarm*
"#;

        let mut doc = parse_markdown(markdown);
        let engine = LayoutEngine::new(800.0, theme.clone());
        engine.layout(&mut doc);

        Self {
            gpu: None,
            document: Arc::new(Mutex::new(doc)),
            theme,
            renderer: None,
            scroll_offset: 0.0,
            viewport: (800.0, 600.0),
            kimi: None,
            staging_buffers: [None, None],
            staging_flip: 0,
            staging_dims: (0, 0),
            staging_bpr: 0,
            auto_scroll: true,
        }
    }

    pub async fn init_gpu(&mut self) {
        let gpu = GpuContext::new_headless().await;
        let renderer = MarkdownRenderer::new(&gpu);
        self.gpu = Some(gpu);
        self.renderer = Some(renderer);
        // Rebuild text buffers with initial document content
        let doc = self.document.lock().unwrap();
        if let Some(ref mut renderer) = self.renderer {
            renderer.rebuild_buffers(&doc, &self.theme);
        }
    }

    pub fn set_viewport(&mut self, width: f32, height: f32) {
        self.viewport = (width, height);
        if let Some(ref mut renderer) = self.renderer {
            if let Some(ref gpu) = self.gpu {
                renderer.resize(&gpu.queue, width as u32, height as u32);
            }
        }
        {
            let mut doc = self.document.lock().unwrap();
            let engine = LayoutEngine::new(width, self.theme.clone());
            engine.layout(&mut doc);
            if let Some(ref mut renderer) = self.renderer {
                renderer.rebuild_buffers(&doc, &self.theme);
            }
        }
        if self.auto_scroll {
            self.scroll_to_bottom();
        }
    }

    pub fn scroll(&mut self, delta: f32) {
        let doc = self.document.lock().unwrap();
        let max_scroll = (doc.total_height - self.viewport.1).max(0.0);
        drop(doc);
        self.scroll_offset = (self.scroll_offset + delta).clamp(0.0, max_scroll);
        let near_bottom = self.scroll_offset >= max_scroll - 5.0;
        self.auto_scroll = near_bottom;
    }

    pub fn scroll_to_bottom(&mut self) {
        let doc = self.document.lock().unwrap();
        let max_scroll = (doc.total_height - self.viewport.1).max(0.0);
        drop(doc);
        self.scroll_offset = max_scroll;
        self.auto_scroll = true;
    }

    pub fn add_user_message(&mut self, text: &str) {
        {
            let mut doc = self.document.lock().unwrap();
            let mut user_elem = parse_markdown(text);
            for elem in &mut user_elem.elements {
                elem.role = Some("user".into());
            }
            doc.elements.extend(user_elem.elements);
            let engine = LayoutEngine::new(self.viewport.0, self.theme.clone());
            engine.layout(&mut doc);
            if let Some(ref mut renderer) = self.renderer {
                renderer.rebuild_buffers(&doc, &self.theme);
            }
        }
        if self.auto_scroll {
            self.scroll_to_bottom();
        }
    }

    pub fn add_assistant_message(&mut self, text: &str) {
        {
            let mut doc = self.document.lock().unwrap();
            let mut assistant_elem = parse_markdown(text);
            for elem in &mut assistant_elem.elements {
                elem.role = Some("assistant".into());
            }
            doc.elements.extend(assistant_elem.elements);
            let engine = LayoutEngine::new(self.viewport.0, self.theme.clone());
            engine.layout(&mut doc);
            if let Some(ref mut renderer) = self.renderer {
                renderer.rebuild_buffers(&doc, &self.theme);
            }
        }
        if self.auto_scroll {
            self.scroll_to_bottom();
        }
    }

    pub fn add_error_message(&mut self, error: &str) {
        {
            let mut doc = self.document.lock().unwrap();
            let mut error_elem = parse_markdown(&format!("*{}*", error));
            for elem in &mut error_elem.elements {
                elem.role = Some("error".into());
            }
            doc.elements.extend(error_elem.elements);
            let engine = LayoutEngine::new(self.viewport.0, self.theme.clone());
            engine.layout(&mut doc);
            if let Some(ref mut renderer) = self.renderer {
                renderer.rebuild_buffers(&doc, &self.theme);
            }
        }
        if self.auto_scroll {
            self.scroll_to_bottom();
        }
    }

    pub fn render(&mut self) {
        #[cfg(target_arch = "wasm32")]
        js_sys::eval("console.log('[Rust] app.render() called')").ok();
        let Some(ref gpu) = self.gpu else { return };
        let Some(ref mut renderer) = self.renderer else { return };

        let width = self.viewport.0 as u32;
        let height = self.viewport.1 as u32;
        if width == 0 || height == 0 { return; }

        let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("offscreen"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: gpu.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("render") });

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("main_pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(self.theme.background.to_wgpu()),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                occlusion_query_set: None,
                timestamp_writes: None,
                multiview_mask: None,
            });

            let doc = self.document.lock().unwrap();
            let (vw, vh) = self.viewport;
            renderer.render(
                &mut pass,
                &doc,
                self.scroll_offset,
                vw,
                vh,
                &self.theme,
                gpu,
            );
            drop(doc);
            drop(pass);
        }

        let aligned_bpr = ((width * 4 + 255) / 256) * 256;
        let buffer_size = (aligned_bpr * height) as u64;

        // Ensure both buffers exist for the current dimensions
        for slot in &mut self.staging_buffers {
            if slot.is_none() || self.staging_dims != (width, height) {
                let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("staging"),
                    size: buffer_size,
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                });
                *slot = Some(Arc::new(buffer));
            }
        }

        // Use the current flip buffer for copy; the other buffer is for reading
        let copy_idx = self.staging_flip;
        let copy_buffer = self.staging_buffers[copy_idx].as_ref().unwrap();

        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &copy_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(aligned_bpr),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );

        gpu.queue.submit(std::iter::once(encoder.finish()));

        // Flip for next frame: the buffer we just wrote to becomes the read buffer next frame
        self.staging_flip = 1 - self.staging_flip;
        self.staging_dims = (width, height);
        self.staging_bpr = aligned_bpr;
    }

    pub fn take_staging_data(&mut self) -> Option<(Arc<wgpu::Buffer>, u32, u32, u32)> {
        // Return the buffer from the PREVIOUS frame (now the read buffer)
        let read_idx = 1 - self.staging_flip;
        let buffer = self.staging_buffers[read_idx].clone()?;
        Some((buffer, self.staging_dims.0, self.staging_dims.1, self.staging_bpr))
    }

    pub async fn read_pixels(&mut self) -> js_sys::Uint8Array {
        let read_idx = 1 - self.staging_flip;
        let buffer = match self.staging_buffers[read_idx].clone() {
            Some(b) => b,
            None => return js_sys::Uint8Array::new_with_length(0),
        };
        let (width, height) = self.staging_dims;
        let aligned_bpr = self.staging_bpr;

        let slice = buffer.slice(..);
        let promise = js_sys::Promise::new(&mut |resolve, _reject| {
            slice.map_async(wgpu::MapMode::Read, move |result| {
                if result.is_ok() {
                    let _ = resolve.call0(&JsValue::undefined());
                } else {
                    let _ = _reject.call0(&JsValue::undefined());
                }
            });
        });

        wasm_bindgen_futures::JsFuture::from(promise).await.unwrap();

        let data = slice.get_mapped_range();
        let mut pixels = vec![0u8; (width * height * 4) as usize];
        for row in 0..height {
            let src_start = (row * aligned_bpr) as usize;
            let dst_start = (row * width * 4) as usize;
            let row_bytes = (width * 4) as usize;
            pixels[dst_start..dst_start + row_bytes]
                .copy_from_slice(&data[src_start..src_start + row_bytes]);
        }
        drop(data);
        buffer.unmap();

        let array = js_sys::Uint8Array::new_with_length(pixels.len() as u32);
        array.copy_from(&pixels);
        array
    }

    pub async fn run(mut self) {
        #[cfg(target_arch = "wasm32")] {
            use wasm_bindgen::prelude::*;
            use web_sys::window;

            let win = window().expect("no window");
            let doc = win.document().expect("no document");
            let canvas = doc.get_element_by_id("canvas").expect("no canvas");
            let canvas: web_sys::HtmlCanvasElement = canvas.dyn_into().expect("not canvas");

            let width = canvas.client_width() as f32;
            let height = canvas.client_height() as f32;
            canvas.set_width(width as u32);
            canvas.set_height(height as u32);
            self.set_viewport(width, height);

            let app = Arc::new(Mutex::new(self));
            let closure = Arc::new(Mutex::new(None::<Closure<dyn FnMut()>>));
            let closure2 = closure.clone();
            let app2 = app.clone();

            *closure.lock().unwrap() = Some(Closure::wrap(Box::new(move || {
                let mut app = app2.lock().unwrap();
                app.render();
                let win = window().unwrap();
                win.request_animation_frame(
                    closure2.lock().unwrap().as_ref().unwrap().as_ref().unchecked_ref()
                ).unwrap();
            }) as Box<dyn FnMut()>));

            win.request_animation_frame(
                closure.lock().unwrap().as_ref().unwrap().as_ref().unchecked_ref()
            ).unwrap();
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl winit::application::ApplicationHandler for App {
    fn resumed(&mut self, _event_loop: &winit::event_loop::ActiveEventLoop) {}

    fn window_event(
        &mut self,
        event_loop: &winit::event_loop::ActiveEventLoop,
        _window_id: winit::window::WindowId,
        event: winit::event::WindowEvent,
    ) {
        match event {
            winit::event::WindowEvent::CloseRequested => event_loop.exit(),
            winit::event::WindowEvent::Resized(size) => {
                self.set_viewport(size.width as f32, size.height as f32);
            }
            winit::event::WindowEvent::MouseWheel { delta, .. } => {
                let dy = match delta {
                    winit::event::MouseScrollDelta::LineDelta(_, y) => y * 30.0,
                    winit::event::MouseScrollDelta::PixelDelta(pos) => pos.y as f32,
                };
                self.scroll(-dy);
            }
            _ => {}
        }
    }
}

// Global streaming state accessors
pub fn set_streaming_chars(chars: u32) {
    if let Ok(mut c) = STREAMING_CHARS.lock() {
        *c = chars;
    }
}

pub fn get_streaming_chars() -> u32 {
    if let Ok(c) = STREAMING_CHARS.lock() {
        *c
    } else {
        0
    }
}

pub fn set_streaming_active(active: bool) {
    if let Ok(mut a) = STREAMING_ACTIVE.lock() {
        *a = active;
    }
}

pub fn is_streaming_active_global() -> bool {
    if let Ok(a) = STREAMING_ACTIVE.lock() {
        *a
    } else {
        false
    }
}

use crate::gpu::{GpuContext, RectPipeline, TextPipeline};
use crate::theme::Theme;
use super::{MdDocument, MdElement, MdElementKind, TextSpan};

pub struct MarkdownRenderer {
    rect_pipeline: RectPipeline,
    text_pipeline: TextPipeline,
    text_buffers: Vec<glyphon::Buffer>,
    label_buffers: Vec<glyphon::Buffer>,
    label_info: Vec<(f32, String, glyphon::Color)>, // (doc_y, role, color)
}

impl MarkdownRenderer {
    pub fn new(gpu: &GpuContext) -> Self {
        let rect_pipeline = RectPipeline::new(&gpu.device, gpu.format);
        let text_pipeline = TextPipeline::new(&gpu.device, &gpu.queue, gpu.format);
        Self {
            rect_pipeline,
            text_pipeline,
            text_buffers: Vec::new(),
            label_buffers: Vec::new(),
            label_info: Vec::new(),
        }
    }

    pub fn resize(&mut self, queue: &wgpu::Queue, width: u32, height: u32) {
        self.text_pipeline.resize(queue, width, height);
        self.rect_pipeline.resize(queue, width as f32, height as f32);
    }

    fn spans_to_text(spans: &[TextSpan]) -> String {
        spans.iter().map(|s| s.text.as_str()).collect::<String>()
    }

    pub fn rebuild_buffers(&mut self, doc: &MdDocument, theme: &Theme) {
        self.text_buffers.clear();
        let mut count = 0;

        for elem in &doc.elements {
            let text = match &elem.kind {
                MdElementKind::Paragraph(spans) => Self::spans_to_text(spans),
                MdElementKind::Heading { text, .. } => Self::spans_to_text(text),
                MdElementKind::CodeBlock { code, .. } => code.clone(),
                MdElementKind::InlineCode { code } => code.clone(),
                MdElementKind::List { items, .. } => items
                    .iter()
                    .map(|item| Self::spans_to_text(&item.text))
                    .collect::<Vec<_>>()
                    .join("\n"),
                MdElementKind::TaskItem { text, .. } => Self::spans_to_text(text),
                MdElementKind::BlockQuote { children } => children
                    .iter()
                    .filter_map(|c| match &c.kind {
                        MdElementKind::Paragraph(spans) => Some(Self::spans_to_text(spans)),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => continue,
            };

            if text.trim().is_empty() {
                let metrics = glyphon::Metrics::new(1.0, 1.0);
                let buffer = self.text_pipeline.create_buffer("", metrics, 1.0);
                self.text_buffers.push(buffer);
                continue;
            }

            let font_size = match &elem.kind {
                MdElementKind::Heading { level, .. } => {
                    theme.font_size_base * (1.8 - (*level as f32 * 0.15))
                }
                MdElementKind::CodeBlock { .. } => theme.font_size_code,
                MdElementKind::InlineCode { .. } => theme.font_size_code,
                _ => theme.font_size_base,
            };

            let metrics = glyphon::Metrics::new(font_size, font_size * theme.line_height);
            // For bubble elements, constrain buffer width to bubble content width
            let buffer_width = if elem.role.is_some() {
                // Bubble max width minus padding on both sides
                (elem.width * 0.85).min(600.0) - 16.0
            } else {
                elem.width
            };
            let width = buffer_width.max(100.0);
            let buffer = self.text_pipeline.create_buffer(&text, metrics, width);
            self.text_buffers.push(buffer);
            count += 1;
        }

        #[cfg(target_arch = "wasm32")]
        {
            // log disabled
        }

        // Build bubble labels
        self.label_buffers.clear();
        self.label_info.clear();
        let mut prev_role: Option<String> = None;
        for elem in &doc.elements {
            if let Some(ref role) = elem.role {
                if prev_role.as_ref() != Some(role) {
                    let label_text = if role == "user" { "You" } else { "Kimi" };
                    let label_metrics = glyphon::Metrics::new(11.0, 14.0);
                    let label_buffer = self.text_pipeline.create_buffer(label_text, label_metrics, 200.0);
                    let label_color = if role == "user" {
                        glyphon::Color::rgb(0x88, 0xbb, 0xff)
                    } else {
                        glyphon::Color::rgb(0x88, 0x88, 0x88)
                    };
                    self.label_buffers.push(label_buffer);
                    self.label_info.push((elem.y_offset.unwrap_or(0.0), role.clone(), label_color));
                }
            }
            prev_role = elem.role.clone();
        }
    }

    pub fn render<'a>(
        &'a mut self,
        pass: &mut wgpu::RenderPass<'a>,
        doc: &MdDocument,
        scroll_offset: f32,
        viewport_w: f32,
        viewport_h: f32,
        theme: &Theme,
        gpu: &GpuContext,
    ) {
        self.rect_pipeline.clear();

        // First pass: draw bubble backgrounds for elements with roles
        let mut bubble_start_y: Option<f32> = None;
        let mut bubble_end_y: f32 = 0.0;
        let mut bubble_role: Option<String> = None;
        let bubble_max_width = (viewport_w * 0.85).min(600.0);
        let bubble_padding = 4.0f32;

        for elem in &doc.elements {
            let y = elem.y_offset.unwrap_or(0.0) - scroll_offset;
            if y + elem.height < 0.0 || y > viewport_h {
                continue;
            }
            if let Some(ref role) = elem.role {
                if bubble_role.as_ref() != Some(role) {
                    // Draw previous bubble
                    if let Some(start_y) = bubble_start_y {
                        let is_user = bubble_role.as_deref() == Some("user");
                        let bg = if is_user { theme.user_bubble_bg } else { theme.assistant_bubble_bg };
                        let bubble_w = bubble_max_width;
                        let bubble_x = if is_user {
                            viewport_w - bubble_w - 16.0
                        } else {
                            16.0
                        };
                        self.rect_pipeline.add_rect(
                            bubble_x,
                            start_y - bubble_padding,
                            bubble_w,
                            bubble_end_y - start_y + bubble_padding * 2.0,
                            bg,
                        );
                    }
                    bubble_start_y = Some(y);
                    bubble_role = Some(role.clone());
                }
                bubble_end_y = y + elem.height;
            } else {
                // Draw previous bubble if any
                if let Some(start_y) = bubble_start_y {
                    let is_user = bubble_role.as_deref() == Some("user");
                    let bg = if is_user { theme.user_bubble_bg } else { theme.assistant_bubble_bg };
                    let bubble_w = bubble_max_width;
                    let bubble_x = if is_user {
                        viewport_w - bubble_w - 16.0
                    } else {
                        16.0
                    };
                    self.rect_pipeline.add_rect(
                        bubble_x,
                        start_y - bubble_padding,
                        bubble_w,
                        bubble_end_y - start_y + bubble_padding * 2.0,
                        bg,
                    );
                    bubble_start_y = None;
                    bubble_role = None;
                }
            }
        }
        // Draw final bubble
        if let Some(start_y) = bubble_start_y {
            let is_user = bubble_role.as_deref() == Some("user");
            let bg = if is_user { theme.user_bubble_bg } else { theme.assistant_bubble_bg };
            let bubble_w = bubble_max_width;
            let bubble_x = if is_user {
                viewport_w - bubble_w - 16.0
            } else {
                16.0
            };
            self.rect_pipeline.add_rect(
                bubble_x,
                start_y - bubble_padding,
                bubble_w,
                bubble_end_y - start_y + bubble_padding * 2.0,
                bg,
            );
        }

        for elem in &doc.elements {
            let y = elem.y_offset.unwrap_or(0.0) - scroll_offset;
            if y + elem.height < 0.0 || y > viewport_h {
                continue;
            }

            match &elem.kind {
                MdElementKind::CodeBlock { .. } => {
                    self.rect_pipeline.add_rect(
                        8.0,
                        y,
                        elem.width - 16.0,
                        elem.height,
                        theme.code_bg,
                    );
                }
                MdElementKind::HorizontalRule => {
                    self.rect_pipeline.add_rect(
                        8.0,
                        y + elem.height / 2.0 - 1.0,
                        elem.width - 16.0,
                        2.0,
                        theme.border,
                    );
                }
                MdElementKind::BlockQuote { .. } => {
                    self.rect_pipeline
                        .add_rect(8.0, y, 4.0, elem.height, theme.quote_bar);
                }
                _ => {}
            }
        }

        self.rect_pipeline.upload(&gpu.queue);
        self.rect_pipeline.render(pass);

        // Build text areas from buffers
        let mut text_areas = Vec::new();
        let mut buffer_idx = 0;

        for elem in &doc.elements {
            let y = elem.y_offset.unwrap_or(0.0) - scroll_offset;
            if y + elem.height < 0.0 || y > viewport_h {
                if Self::element_has_text(&elem.kind) {
                    // Skip this buffer
                    buffer_idx += 1;
                }
                continue;
            }

            if !Self::element_has_text(&elem.kind) {
                continue;
            }

            if buffer_idx >= self.text_buffers.len() {
                break;
            }

            let left = match &elem.kind {
                MdElementKind::CodeBlock { .. } => 16.0,
                MdElementKind::BlockQuote { .. } => 20.0,
                MdElementKind::List { .. } => 24.0,
                _ => 8.0,
            };

            let bubble_left = if let Some(ref role) = elem.role {
                let is_user = role == "user";
                let bubble_w = (viewport_w * 0.85).min(600.0);
                if is_user {
                    viewport_w - bubble_w - 16.0 + 8.0
                } else {
                    16.0 + 8.0
                }
            } else {
                left
            };

            let color = match &elem.kind {
                MdElementKind::Heading { level, .. } => {
                    let idx = (*level as usize).saturating_sub(1).min(5);
                    theme.heading_colors[idx].to_glyphon()
                }
                MdElementKind::CodeBlock { .. } | MdElementKind::InlineCode { .. } => {
                    theme.code_text.to_glyphon()
                }
                _ => theme.text.to_glyphon(),
            };

            text_areas.push(glyphon::TextArea {
                buffer: &self.text_buffers[buffer_idx],
                left: bubble_left,
                top: y,
                scale: 1.0,
                bounds: glyphon::TextBounds {
                    left: 0,
                    top: 0,
                    right: viewport_w as i32,
                    bottom: viewport_h as i32,
                },
                default_color: color,
                custom_glyphs: &[],
            });

            buffer_idx += 1;
        }

        // Add bubble labels above each bubble
        for (i, (doc_y, role, color)) in self.label_info.iter().enumerate() {
            if i >= self.label_buffers.len() {
                break;
            }
            let y = doc_y - 18.0 - scroll_offset;
            if y + 14.0 < 0.0 || y > viewport_h {
                continue;
            }
            let x = if role == "user" {
                viewport_w - bubble_max_width - 16.0 + bubble_max_width - 40.0
            } else {
                16.0 + 8.0
            };
            text_areas.push(glyphon::TextArea {
                buffer: &self.label_buffers[i],
                left: x,
                top: y,
                scale: 1.0,
                bounds: glyphon::TextBounds {
                    left: 0,
                    top: 0,
                    right: viewport_w as i32,
                    bottom: viewport_h as i32,
                },
                default_color: *color,
                custom_glyphs: &[],
            });
        }

        if !text_areas.is_empty() {
            #[cfg(target_arch = "wasm32")]
            {
                js_sys::eval(&format!("window.__textAreas = {}", text_areas.len())).ok();
            }
            self.text_pipeline
                .prepare(&gpu.device, &gpu.queue, text_areas);
            self.text_pipeline.render(pass);
        }
    }

    fn element_has_text(kind: &MdElementKind) -> bool {
        matches!(
            kind,
            MdElementKind::Paragraph(_)
                | MdElementKind::Heading { .. }
                | MdElementKind::CodeBlock { .. }
                | MdElementKind::InlineCode { .. }
                | MdElementKind::List { .. }
                | MdElementKind::TaskItem { .. }
                | MdElementKind::BlockQuote { .. }
        )
    }
}

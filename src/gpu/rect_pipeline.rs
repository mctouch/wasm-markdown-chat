use wgpu::{
    BlendState, BufferUsages, ColorTargetState, ColorWrites, Device, FragmentState,
    MultisampleState, PipelineLayoutDescriptor, PrimitiveState, PrimitiveTopology, Queue,
    RenderPipeline, ShaderModuleDescriptor, ShaderSource, VertexAttribute, VertexBufferLayout,
    VertexState, VertexStepMode,
};
use crate::theme::colors::ThemeColor;

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct RectInstance {
    pos: [f32; 2],
    size: [f32; 2],
    color: [f32; 4],
}

#[repr(C)]
#[derive(Copy, Clone, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct ViewportUniform {
    size: [f32; 2],
    _pad: [f32; 2],
}

pub struct RectPipeline {
    pipeline: RenderPipeline,
    instance_buffer: wgpu::Buffer,
    instances: Vec<RectInstance>,
    viewport_buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

impl RectPipeline {
    pub fn new(device: &Device, format: wgpu::TextureFormat) -> Self {
        let shader_src = r#"
struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@group(0) @binding(0)
var<uniform> u_viewport: vec2<f32>;

@vertex
fn vs_main(
    @builtin(vertex_index) vertex_index: u32,
    @location(0) pos: vec2<f32>,
    @location(1) size: vec2<f32>,
    @location(2) color: vec4<f32>,
) -> VertexOutput {
    var out: VertexOutput;
    let vertex_pos = array<vec2<f32>, 4>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0),
    );
    let p = vertex_pos[vertex_index];
    let screen_pos = pos + p * size;
    let ndc = (screen_pos / u_viewport) * 2.0 - 1.0;
    // Flip Y because WebGPU NDC has Y up, but screen coords have Y down
    out.clip_position = vec4<f32>(ndc.x, -ndc.y, 0.0, 1.0);
    out.color = color;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    return in.color;
}
"#;

        let shader = device.create_shader_module(ShaderModuleDescriptor {
            label: Some("rect_shader"),
            source: ShaderSource::Wgsl(shader_src.into()),
        });

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("rect_bind_group_layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let pipeline_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some("rect_pipeline_layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("rect_pipeline"),
            layout: Some(&pipeline_layout),
            vertex: VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[VertexBufferLayout {
                    array_stride: std::mem::size_of::<RectInstance>() as wgpu::BufferAddress,
                    step_mode: VertexStepMode::Instance,
                    attributes: &[
                        VertexAttribute {
                            format: wgpu::VertexFormat::Float32x2,
                            offset: 0,
                            shader_location: 0,
                        },
                        VertexAttribute {
                            format: wgpu::VertexFormat::Float32x2,
                            offset: 8,
                            shader_location: 1,
                        },
                        VertexAttribute {
                            format: wgpu::VertexFormat::Float32x4,
                            offset: 16,
                            shader_location: 2,
                        },
                    ],
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(ColorTargetState {
                    format,
                    blend: Some(BlendState::ALPHA_BLENDING),
                    write_mask: ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: PrimitiveState {
                topology: PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        let instance_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("rect_instances"),
            size: 1024 * std::mem::size_of::<RectInstance>() as wgpu::BufferAddress,
            usage: BufferUsages::VERTEX | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let viewport_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("rect_viewport"),
            size: std::mem::size_of::<ViewportUniform>() as wgpu::BufferAddress,
            usage: BufferUsages::UNIFORM | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("rect_bind_group"),
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: viewport_buffer.as_entire_binding(),
            }],
        });

        Self {
            pipeline,
            instance_buffer,
            instances: Vec::new(),
            viewport_buffer,
            bind_group,
        }
    }

    pub fn resize(&mut self, queue: &Queue, width: f32, height: f32) {
        let uniform = ViewportUniform {
            size: [width, height],
            _pad: [0.0, 0.0],
        };
        queue.write_buffer(&self.viewport_buffer, 0, bytemuck::cast_slice(&[uniform]));
    }

    pub fn clear(&mut self) {
        self.instances.clear();
    }

    pub fn add_rect(&mut self, x: f32, y: f32, w: f32, h: f32, color: ThemeColor) {
        self.instances.push(RectInstance {
            pos: [x, y],
            size: [w, h],
            color: color.to_f32_array(),
        });
    }

    pub fn upload(&mut self, queue: &Queue) {
        if self.instances.is_empty() {
            return;
        }
        let data = bytemuck::cast_slice(&self.instances);
        if data.len() as wgpu::BufferAddress > self.instance_buffer.size() {
            return;
        }
        queue.write_buffer(&self.instance_buffer, 0, data);
    }

    pub fn instance_count(&self) -> usize {
        self.instances.len()
    }

    pub fn render<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        if self.instances.is_empty() {
            return;
        }
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.set_vertex_buffer(0, self.instance_buffer.slice(..));
        pass.draw(0..4, 0..self.instances.len() as u32);
    }
}

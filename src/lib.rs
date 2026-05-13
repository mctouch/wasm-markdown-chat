use wasm_bindgen::prelude::*;

pub mod app;
pub mod avatar;
pub mod chat;
pub mod gpu;
pub mod markdown;
pub mod theme;

use app::App;
use crate::chat::kimi::Message;
use std::sync::{Arc, Mutex};

static mut APP: Option<Arc<Mutex<App>>> = None;

#[wasm_bindgen]
pub async fn boot_app() -> Result<(), JsValue> {
    console_error_panic_hook::set_once();
    wasm_logger::init(wasm_logger::Config::new(log::Level::Error));

    let mut app = App::new().await;

    #[cfg(target_arch = "wasm32")]
    {
        use web_sys::{window, HtmlCanvasElement};

        let win = window().expect("no window");
        let doc = win.document().expect("no document");
        let container = doc.get_element_by_id("canvas-container").expect("no container");

        // Remove old canvas if exists
        if let Some(old) = doc.get_element_by_id("canvas") {
            let _ = old.remove();
        }

        // Create fresh canvas
        let canvas = doc.create_element("canvas").expect("create canvas");
        canvas.set_id("canvas");
        let canvas: HtmlCanvasElement = canvas.dyn_into().expect("cast canvas");

        let container_w = container.client_width() as u32;
        let container_h = container.client_height() as u32;
        canvas.set_width(container_w);
        canvas.set_height(container_h);
        canvas.style().set_property("width", "100%").ok();
        canvas.style().set_property("height", "100%").ok();
        canvas.style().set_property("display", "block").ok();

        container.append_child(&canvas).expect("append canvas");

        app.init_gpu().await;
        app.set_viewport(container_w as f32, container_h as f32);

        let app = Arc::new(Mutex::new(app));
        unsafe { APP = Some(app.clone()) };
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        app.init_gpu().await;
        let app = Arc::new(Mutex::new(app));
        unsafe { APP = Some(app.clone()) };
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    Ok(())
}

#[wasm_bindgen]
pub fn render_frame() {
    unsafe {
        if let Some(ref app) = APP {
            let mut app = app.lock().unwrap();
            app.render();
        } else {
            #[cfg(target_arch = "wasm32")]
            web_sys::console::log_1(&"[Rust] APP is None".into());
        }
    }
}

#[wasm_bindgen]
pub async fn read_pixels() -> js_sys::Uint8Array {
    unsafe {
        // Clone Arc from staging buffer, release lock before await
        let staging = if let Some(ref app) = APP {
            let mut app = app.lock().unwrap();
            app.take_staging_data()
        } else {
            None
        };

        let Some((arc_buffer, width, height, aligned_bpr)) = staging else {
            return js_sys::Uint8Array::new_with_length(0);
        };

        // APP lock is released. Clone Arc for the async readback.
        let buffer_for_read = Arc::clone(&arc_buffer);
        let slice = buffer_for_read.slice(..);
        let promise = js_sys::Promise::new(&mut |resolve, _reject| {
            slice.map_async(wgpu::MapMode::Read, move |result| {
                if result.is_ok() {
                    let _ = resolve.call0(&JsValue::undefined());
                } else {
                    let _ = _reject.call1(&JsValue::undefined(), &JsValue::from_str("map_async failed"));
                }
            });
        });

        match wasm_bindgen_futures::JsFuture::from(promise).await {
            Ok(_) => {}
            Err(e) => {
                log::error!("read_pixels map_async failed: {:?}", e);
                return js_sys::Uint8Array::new_with_length(0);
            }
        }

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
        buffer_for_read.unmap();

        let array = js_sys::Uint8Array::new_with_length(pixels.len() as u32);
        array.copy_from(&pixels);
        array
    }
}

#[wasm_bindgen]
pub fn send_message(text: String) {
    wasm_bindgen_futures::spawn_local(async move {
        unsafe {
            // 1. Add user message and extract kimi state
            let (api_key, messages, model, max_history) = if let Some(ref app) = APP {
                let mut app = app.lock().unwrap();
                app.add_user_message(&text);
                if let Some(ref kimi) = app.kimi {
                    (kimi.api_key.clone(), kimi.messages.clone(), kimi.model.clone(), kimi.max_history)
                } else {
                    return;
                }
            } else {
                return;
            };

            // 2. Do streaming HTTP call without holding app lock
            let mut temp_kimi = crate::chat::kimi::KimiClient {
                api_key,
                messages,
                model,
                max_history,
            };

            let mut full_response = String::new();
            crate::app::set_streaming_active(true);
            crate::app::set_streaming_chars(0);

            let result = temp_kimi.chat_stream(&text, |chunk| {
                full_response.push_str(chunk);
                crate::app::set_streaming_chars(full_response.len() as u32);
            }).await;

            crate::app::set_streaming_active(false);
            crate::app::set_streaming_chars(0);

            // 3. Re-acquire lock to update app state
            if let Some(ref app) = APP {
                let mut app = app.lock().unwrap();

                // Update kimi messages
                if let Some(ref mut kimi) = app.kimi {
                    kimi.messages = temp_kimi.messages;
                }

                match result {
                    Ok(_) => {
                        app.add_assistant_message(&full_response);
                        if let Some(ref mut kimi) = app.kimi {
                            kimi.messages.push(Message {
                                role: "assistant".to_string(),
                                content: full_response.clone(),
                            });
                        }
                    }
                    Err(e) => {
                        let err_str = format!("{:?}", e);
                        app.add_error_message(&err_str);
                    }
                }
            }
        }
    });
}

#[wasm_bindgen]
pub fn get_streaming_length() -> u32 {
    crate::app::get_streaming_chars()
}

#[wasm_bindgen]
pub fn is_streaming() -> bool {
    crate::app::is_streaming_active_global()
}

#[wasm_bindgen]
pub fn init_kimi(api_key: String) {
    unsafe {
        if let Some(ref app) = APP {
            let mut app = app.lock().unwrap();
            app.kimi = Some(crate::chat::kimi::KimiClient::new(api_key));
        }
    }
}

#[wasm_bindgen]
pub fn scroll(delta_y: f32) {
    unsafe {
        if let Some(ref app) = APP {
            let mut app = app.lock().unwrap();
            app.scroll(delta_y);
        }
    }
}

#[wasm_bindgen]
pub fn resize(width: f32, height: f32) {
    unsafe {
        if let Some(ref app) = APP {
            let mut app = app.lock().unwrap();
            app.set_viewport(width, height);
        }
    }
}

#[wasm_bindgen]
pub fn inject_test_messages() {
    unsafe {
        if let Some(ref app) = APP {
            let mut app = app.lock().unwrap();
            app.add_user_message("Hello Kimi");
            app.add_assistant_message("Hello! How can I help you today?");
        }
    }
}

#[wasm_bindgen]
pub fn get_last_assistant_message() -> String {
    unsafe {
        if let Some(ref app) = APP {
            let app = app.lock().unwrap();
            if let Some(ref kimi) = app.kimi {
                return kimi.get_last_assistant_message().unwrap_or_default();
            }
        }
        String::new()
    }
}

#[wasm_bindgen]
pub fn set_theme(name: String) {
    unsafe {
        if let Some(ref app) = APP {
            let mut app = app.lock().unwrap();
            app.theme = crate::theme::Theme::dark();
            log::info!("Theme switch requested: {}", name);
        }
    }
}

// Avatar WebSocket exports
#[wasm_bindgen]
pub fn connect_avatar_ws(url: String) -> Result<(), JsValue> {
    crate::avatar::connect_ws(&url)?;
    Ok(())
}

#[wasm_bindgen]
pub fn get_blendshape_json() -> String {
    crate::avatar::get_latest_frame_json()
}

#[wasm_bindgen]
pub fn get_avatar_ws_status() -> String {
    crate::avatar::get_ws_status()
}

#[wasm_bindgen]
pub fn set_blendshape_frame(json: String) -> Result<(), JsValue> {
    crate::avatar::set_frame_from_json(&json)
}

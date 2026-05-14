use serde::{Deserialize, Serialize};
use wasm_bindgen_futures::JsFuture;
use wasm_bindgen::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [Message],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: Msg,
}

#[derive(Debug, Deserialize)]
struct Msg {
    content: String,
}

#[derive(Debug, Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: Delta,
}

#[derive(Debug, Deserialize, Default)]
struct Delta {
    #[serde(default)]
    content: String,
    #[serde(default)]
    reasoning_content: String,
}

pub struct KimiClient {
    pub api_key: String,
    pub messages: Vec<Message>,
    pub model: String,
    pub max_history: usize,
}

impl KimiClient {
    pub fn new() -> Self {
        Self {
            api_key: "sk-eXbDzicqr3lDQMxgEsr1JPJ9B92wwzwm4dy3NUrwhppYDnxx".into(),
            messages: Vec::new(),
            model: "moonshot-v1-8k".into(),
            max_history: 20,
        }
    }

    pub fn get_last_assistant_message(&self) -> Option<String> {
        self.messages.iter().rev().find(|m| m.role == "assistant").map(|m| m.content.clone())
    }

    pub fn set_system_prompt(&mut self, prompt: &str) {
        self.messages.retain(|m| m.role != "system");
        self.messages.insert(0, Message {
            role: "system".into(),
            content: prompt.into(),
        });
    }

    fn build_request_messages(&self, user_input: &str) -> Vec<Message> {
        let mut result = Vec::new();
        if let Some(sys) = self.messages.iter().find(|m| m.role == "system") {
            result.push(sys.clone());
        }
        let history: Vec<_> = self.messages.iter().filter(|m| m.role != "system").cloned().collect();
        let start = history.len().saturating_sub(self.max_history * 2);
        result.extend_from_slice(&history[start..]);
        result.push(Message {
            role: "user".into(),
            content: user_input.into(),
        });
        result
    }

    #[cfg(target_arch = "wasm32")]
    pub async fn chat(&mut self, user_input: &str) -> Result<String, JsValue> {
        let request_messages = self.build_request_messages(user_input);
        let body = ChatRequest {
            model: &self.model,
            messages: &request_messages,
            stream: false,
            temperature: None, // Some models only allow temperature=1
        };

        let js_body = serde_json::to_string(&body).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let window = web_sys::window().ok_or("no window")?;

        let mut init = web_sys::RequestInit::new();
        init.method("POST");
        init.body(Some(&js_sys::JsString::from(js_body)));
        init.mode(web_sys::RequestMode::Cors);

        let request = web_sys::Request::new_with_str_and_init(
            "https://api.moonshot.ai/v1/chat/completions",
            &init,
        ).map_err(|e| e)?;
        request.headers().set("Authorization", &format!("Bearer {}", self.api_key)).map_err(|e| e)?;
        request.headers().set("Content-Type", "application/json").map_err(|e| e)?;

        let resp = JsFuture::from(window.fetch_with_request(&request)).await.map_err(|e| e)?;
        let resp: web_sys::Response = resp.dyn_into().map_err(|e| e)?;

        if !resp.ok() {
            let text = JsFuture::from(resp.text().unwrap()).await.map_err(|e| e)?;
            return Err(JsValue::from_str(&format!("HTTP error: {:?}", text)));
        }

        let json = JsFuture::from(resp.json().unwrap()).await.map_err(|e| e)?;
        let data: ChatResponse = serde_wasm_bindgen::from_value(json).map_err(|e| JsValue::from_str(&format!("JSON error: {:?}", e)))?;
        let content = data.choices.into_iter().next().map(|c| c.message.content).unwrap_or_default();

        self.messages.push(Message { role: "user".into(), content: user_input.into() });
        self.messages.push(Message { role: "assistant".into(), content: content.clone() });

        Ok(content)
    }

    #[cfg(target_arch = "wasm32")]
    pub async fn chat_stream(&mut self, user_input: &str, on_chunk: impl FnMut(&str)) -> Result<String, JsValue> {
        let mut on_chunk = on_chunk;
        let request_messages = self.build_request_messages(user_input);
        let body = ChatRequest {
            model: &self.model,
            messages: &request_messages,
            stream: true,
            temperature: None, // Some models only allow temperature=1
        };

        let js_body = serde_json::to_string(&body).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let window = web_sys::window().ok_or("no window")?;

        let mut init = web_sys::RequestInit::new();
        init.method("POST");
        init.body(Some(&js_sys::JsString::from(js_body)));
        init.mode(web_sys::RequestMode::Cors);

        let request = web_sys::Request::new_with_str_and_init(
            "https://api.moonshot.ai/v1/chat/completions",
            &init,
        ).map_err(|e| e)?;
        request.headers().set("Authorization", &format!("Bearer {}", self.api_key)).map_err(|e| e)?;
        request.headers().set("Content-Type", "application/json").map_err(|e| e)?;

        let resp = JsFuture::from(window.fetch_with_request(&request)).await.map_err(|e| e)?;
        let resp: web_sys::Response = resp.dyn_into().map_err(|e| e)?;

        if !resp.ok() {
            let text = JsFuture::from(resp.text().unwrap()).await.map_err(|e| e)?;
            return Err(JsValue::from_str(&format!("HTTP error: {:?}", text)));
        }

        let reader = resp.body().ok_or("no body")?.get_reader();
        let mut full = String::new();
        let mut buffer = String::new();
        let decoder = web_sys::TextDecoder::new().map_err(|e| e)?;

        loop {
            let read_fn = js_sys::Reflect::get(&reader, &"read".into()).map_err(|e| e)?;
            let read_fn = js_sys::Function::from(read_fn);
            let read_promise: js_sys::Promise = read_fn.call0(&reader)
                .map_err(|e| e)?.dyn_into().map_err(|e| e)?;
            let chunk = JsFuture::from(read_promise).await.map_err(|e| e)?;
            let done = js_sys::Reflect::get(&chunk, &"done".into()).unwrap().as_bool().unwrap_or(true);
            if done { break; }

            let value = js_sys::Reflect::get(&chunk, &"value".into()).map_err(|e| e)?;
            let bytes = js_sys::Uint8Array::from(value);
            let bytes_vec = bytes.to_vec();
            let text = decoder.decode_with_u8_array(&bytes_vec).map_err(|e| e)?;
            buffer.push_str(&text);

            while let Some(pos) = buffer.find("\n\n") {
                let frame = buffer.split_off(pos + 2);
                let block = std::mem::replace(&mut buffer, frame);
                for line in block.lines() {
                    let line = line.trim();
                    if let Some(data) = line.strip_prefix("data: ") {
                        if data == "[DONE]" { continue; }
                        if let Ok(chunk) = serde_json::from_str::<StreamChunk>(data) {
                            if let Some(delta) = chunk.choices.into_iter().next() {
                                let text = if !delta.delta.content.is_empty() {
                                    &delta.delta.content
                                } else {
                                    &delta.delta.reasoning_content
                                };
                                if !text.is_empty() {
                                    full.push_str(text);
                                    on_chunk(text);
                                }
                            }
                        }
                    }
                }
            }
        }

        self.messages.push(Message { role: "user".into(), content: user_input.into() });
        self.messages.push(Message { role: "assistant".into(), content: full.clone() });

        Ok(full)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub async fn chat(&mut self, user_input: &str) -> Result<String, Box<dyn std::error::Error>> {
        use reqwest::Client;

        let request_messages = self.build_request_messages(user_input);
        let body = ChatRequest {
            model: &self.model,
            messages: &request_messages,
            stream: false,
            temperature: None, // Some models only allow temperature=1
        };

        let client = Client::new();
        let resp = client
            .post("https://api.moonshot.ai/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()).into());
        }

        let data: ChatResponse = resp.json().await?;
        let content = data.choices.into_iter().next().map(|c| c.message.content).unwrap_or_default();

        self.messages.push(Message { role: "user".into(), content: user_input.into() });
        self.messages.push(Message { role: "assistant".into(), content: content.clone() });

        Ok(content)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub async fn chat_stream(&mut self, user_input: &str, mut on_chunk: impl FnMut(&str)) -> Result<String, Box<dyn std::error::Error>> {
        use reqwest::Client;
        use std::io::BufRead;

        let request_messages = self.build_request_messages(user_input);
        let body = ChatRequest {
            model: &self.model,
            messages: &request_messages,
            stream: true,
            temperature: None, // Some models only allow temperature=1
        };

        let client = Client::new();
        let resp = client
            .post("https://api.moonshot.ai/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()).into());
        }

        let bytes = resp.bytes().await?;
        let mut full = String::new();
        use std::io::Cursor;
        for line in Cursor::new(bytes).lines() {
            let line = line?;
            let line = line.trim();
            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" { continue; }
                if let Ok(chunk) = serde_json::from_str::<StreamChunk>(data) {
                    if let Some(delta) = chunk.choices.into_iter().next() {
                                let text = if !delta.delta.content.is_empty() {
                                    &delta.delta.content
                                } else {
                                    &delta.delta.reasoning_content
                                };
                                if !text.is_empty() {
                                    full.push_str(text);
                                    on_chunk(text);
                                }
                    }
                }
            }
        }

        self.messages.push(Message { role: "user".into(), content: user_input.into() });
        self.messages.push(Message { role: "assistant".into(), content: full.clone() });

        Ok(full)
    }
}

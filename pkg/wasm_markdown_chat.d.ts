/* tslint:disable */
/* eslint-disable */

export function boot_app(): void;

export function connect_avatar_ws(url: string): void;

export function get_avatar_ws_status(): string;

export function get_blendshape_json(): string;

export function get_last_assistant_message(): string;

export function get_streaming_length(): number;

export function init_kimi(api_key: string): void;

export function inject_test_messages(): void;

export function is_streaming(): boolean;

export function read_pixels(): Promise<Uint8Array>;

export function render_frame(): void;

export function resize(width: number, height: number): void;

export function scroll(delta_y: number): void;

export function send_message(text: string): void;

export function set_blendshape_frame(json: string): void;

export function set_theme(name: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly boot_app: (a: number) => void;
    readonly connect_avatar_ws: (a: number, b: number, c: number) => void;
    readonly get_avatar_ws_status: (a: number) => void;
    readonly get_blendshape_json: (a: number) => void;
    readonly get_last_assistant_message: (a: number) => void;
    readonly init_kimi: (a: number, b: number) => void;
    readonly is_streaming: () => number;
    readonly read_pixels: () => number;
    readonly send_message: (a: number, b: number) => void;
    readonly set_blendshape_frame: (a: number, b: number, c: number) => void;
    readonly set_theme: (a: number, b: number) => void;
    readonly inject_test_messages: () => void;
    readonly render_frame: () => void;
    readonly get_streaming_length: () => number;
    readonly resize: (a: number, b: number) => void;
    readonly scroll: (a: number) => void;
    readonly __wasm_bindgen_func_elem_4673: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_4666: (a: number, b: number, c: number, d: number) => void;
    readonly __wasm_bindgen_func_elem_3035: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_485: (a: number, b: number, c: number) => void;
    readonly __wasm_bindgen_func_elem_485_3: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export5: (a: number, b: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

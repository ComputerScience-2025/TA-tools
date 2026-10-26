/**
 * Base64 decoding without Node's `Buffer`, so the download path works in the
 * browser as well as in the CLI.
 */

export function base64ToBytes(base64: string): Uint8Array {
    const normalized = base64.replace(/[\r\n\s]/g, "");
    const atobFn = globalThis.atob;
    if (typeof atobFn === "function") {
        const binary = atobFn(normalized);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    const bufferCtor = (globalThis as { Buffer?: { from(input: string, encoding: string): Uint8Array } }).Buffer;
    if (bufferCtor) {
        return new Uint8Array(bufferCtor.from(normalized, "base64"));
    }

    throw new Error("No base64 decoder available on this platform.");
}

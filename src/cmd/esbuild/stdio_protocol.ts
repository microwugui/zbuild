// 1:1 移植自 esbuild cmd/esbuild/stdio_protocol.go（v0.28.2，commit f6058f83）
// 第 44 轮叶子优先规划：二进制协议原语。字节证据由 Go 探针固化在
// testdata/stdio-protocol-go.json。

/** Go: func readUint32(bytes []byte) (value uint32, leftOver []byte, ok bool) (stdio_protocol.go:14) */
export function readUint32(bytes: Uint8Array): { value: number; leftOver: Uint8Array; ok: boolean } {
  if (bytes.length >= 4) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { value: view.getUint32(0, true), leftOver: bytes.subarray(4), ok: true };
  }
  return { value: 0, leftOver: bytes, ok: false };
}

/** Go: func writeUint32(bytes []byte, value uint32) []byte (stdio_protocol.go:22) */
export function writeUint32(bytes: Uint8Array, value: number): Uint8Array {
  const out = new Uint8Array(bytes.length + 4);
  out.set(bytes);
  new DataView(out.buffer).setUint32(bytes.length, value >>> 0, true);
  return out;
}

/** Go: func readLengthPrefixedSlice(bytes []byte) (slice, leftOver []byte, ok bool) (stdio_protocol.go:28) */
export function readLengthPrefixedSlice(bytes: Uint8Array): { slice: Uint8Array; leftOver: Uint8Array; ok: boolean } {
  const { value: length, leftOver: afterLength, ok } = readUint32(bytes);
  if (ok && afterLength.length >= length) {
    return { slice: afterLength.subarray(0, length), leftOver: afterLength.subarray(length), ok: true };
  }
  return { slice: new Uint8Array(0), leftOver: bytes, ok: false };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Go: type packet struct (stdio_protocol.go:38) —— value 的 TS IR：null/bool/int/string/Uint8Array(bytes)/array/object(map) */
export interface Packet { value: any; id: number; isRequest: boolean }

/** Go: func encodePacket(p packet) []byte (stdio_protocol.go:42) */
export function encodePacket(p: Packet): Uint8Array {
  let bytes: Uint8Array = new Uint8Array(0);
  const appendByte = (b: number): void => { const n = new Uint8Array(bytes.length + 1); n.set(bytes); n[bytes.length] = b & 0xff; bytes = n; };
  const appendBytes = (more: Uint8Array): void => { const n = new Uint8Array(bytes.length + more.length); n.set(bytes); n.set(more, bytes.length); bytes = n; };
  const visit = (value: any): void => {
    if (value === null || value === undefined) {
      appendByte(0);
    } else if (typeof value === "boolean") {
      appendByte(1); appendByte(value ? 1 : 0);
    } else if (typeof value === "number") {
      appendByte(2); bytes = writeUint32(bytes, value >>> 0);
    } else if (typeof value === "string") {
      const raw = enc.encode(value);
      appendByte(3); bytes = writeUint32(bytes, raw.length >>> 0); appendBytes(raw);
    } else if (value instanceof Uint8Array) {
      appendByte(4); bytes = writeUint32(bytes, value.length >>> 0); appendBytes(value);
    } else if (Array.isArray(value)) {
      appendByte(5); bytes = writeUint32(bytes, value.length >>> 0);
      for (const item of value) visit(item);
    } else {
      // map[string]interface{} —— sort keys for determinism
      const keys = Object.keys(value).sort();
      appendByte(6); bytes = writeUint32(bytes, keys.length >>> 0);
      for (const k of keys) {
        const raw = enc.encode(k);
        bytes = writeUint32(bytes, raw.length >>> 0); appendBytes(raw);
        visit(value[k]);
      }
    }
  };
  bytes = writeUint32(bytes, 0); // reserve length
  bytes = writeUint32(bytes, p.isRequest ? ((p.id << 1) >>> 0) : (((p.id << 1) | 1) >>> 0));
  visit(p.value);
  // patch length: Go writeUint32(bytes[:0], len-4) writes into first 4 bytes of same backing array
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(0, (bytes.length - 4) >>> 0, true);
  return bytes;
}

/** Go: func decodePacket(bytes []byte) (packet, bool) (stdio_protocol.go:110) */
export function decodePacket(input: Uint8Array): { packet: Packet | null; ok: boolean } {
  let bytes = input;
  const fail = (): { packet: Packet | null; ok: boolean } => ({ packet: null, ok: false });
  const visit = (): { value: any; ok: boolean } => {
    if (bytes.length < 1) return { value: null, ok: false };
    const kind = bytes[0];
    bytes = bytes.subarray(1);
    switch (kind) {
      case 0: return { value: null, ok: true };
      case 1: {
        if (bytes.length < 1) return { value: null, ok: false };
        const v = bytes[0]; bytes = bytes.subarray(1);
        return { value: v !== 0, ok: true };
      }
      case 2: {
        const r = readUint32(bytes);
        if (!r.ok) return { value: null, ok: false };
        bytes = r.leftOver; return { value: r.value | 0, ok: true };
      }
      case 3: {
        const r = readLengthPrefixedSlice(bytes);
        if (!r.ok) return { value: null, ok: false };
        bytes = r.leftOver; return { value: dec.decode(r.slice), ok: true };
      }
      case 4: {
        const r = readLengthPrefixedSlice(bytes);
        if (!r.ok) return { value: null, ok: false };
        bytes = r.leftOver; return { value: r.slice, ok: true };
      }
      case 5: {
        const r = readUint32(bytes);
        if (!r.ok) return { value: null, ok: false };
        bytes = r.leftOver;
        const value: any[] = [];
        for (let i = 0; i < r.value; i++) { const it = visit(); if (!it.ok) return { value: null, ok: false }; value.push(it.value); }
        return { value, ok: true };
      }
      case 6: {
        const r = readUint32(bytes);
        if (!r.ok) return { value: null, ok: false };
        bytes = r.leftOver;
        const value: Record<string, any> = {};
        for (let i = 0; i < r.value; i++) {
          const kr = readLengthPrefixedSlice(bytes);
          if (!kr.ok) return { value: null, ok: false };
          bytes = kr.leftOver;
          const it = visit(); if (!it.ok) return { value: null, ok: false };
          value[dec.decode(kr.slice)] = it.value;
        }
        return { value, ok: true };
      }
      default: throw new Error("Invalid packet");
    }
  };
  const idR = readUint32(bytes);
  if (!idR.ok) return fail();
  const isRequest = (idR.value & 1) === 0;
  const id = idR.value >>> 1;
  bytes = idR.leftOver;
  const v = visit();
  if (!v.ok) return fail();
  if (bytes.length !== 0) return fail();
  return { packet: { value: v.value, id, isRequest }, ok: true };
}

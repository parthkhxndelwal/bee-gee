// Minimal typings for the untyped `pngjs` dependency (pure-JS PNG codec).
declare module "pngjs" {
  export class PNG {
    width: number
    height: number
    data: Buffer
    constructor(options?: { readonly width?: number; readonly height?: number })
    static readonly sync: {
      read(buffer: Uint8Array): PNG
      write(png: PNG): Buffer
    }
  }
}

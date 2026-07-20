// heic2any ships no TypeScript types. Minimal ambient declaration for the one call we make:
// transcode a HEIC/HEIF Blob to a web-renderable format (we use image/jpeg).
declare module 'heic2any' {
  interface Heic2AnyOptions {
    blob: Blob
    toType?: 'image/jpeg' | 'image/png' | 'image/gif'
    quality?: number
  }
  export default function heic2any(options: Heic2AnyOptions): Promise<Blob | Blob[]>
}

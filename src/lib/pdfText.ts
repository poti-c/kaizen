// Browser-side PDF text extraction for the daily hotel reports.
//
// Split out from hotelReports.ts so the parsers themselves stay free of any
// pdfjs import: the same parsing code then runs unchanged in node (tests) and
// could run in Deno (a future Gmail-triggered edge function).
//
// pdfjs is loaded at runtime from its prebuilt file (a `?url` asset), NOT
// bundled. @vitejs/plugin-legacy runs every bundled chunk through Babel for the
// old-browser build, and Babel crashes on pdfjs 6's code — an optional call on a
// private field (`drawLayer.#filterFactory?.createSelectionStyle(...)`) trips
// the Safari class-field transform with "Cannot read properties of null
// (reading 'declarations')", which fails `vite build`. As an asset the file is
// copied untouched, the same way the worker already is. Nothing is lost: pdfjs
// needs a modern browser regardless, and this page is used on a manager's
// desktop.
import type * as PdfJs from 'pdfjs-dist'
import pdfjsUrl from 'pdfjs-dist/build/pdf.min.mjs?url'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PdfTextItem } from '@/lib/hotelReports'

let pdfjsPromise: Promise<typeof PdfJs> | null = null
function loadPdfjs() {
  pdfjsPromise ??= (import(/* @vite-ignore */ pdfjsUrl) as Promise<typeof PdfJs>)
    .then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
      return pdfjs
    })
    .catch((e) => {
      pdfjsPromise = null // let a later attempt retry, e.g. after a network blip
      throw e
    })
  return pdfjsPromise
}

/** Keeps pages in order once all items are sorted by y as one list. */
const PAGE_STRIDE = 100_000

export async function pdfTextItems(file: File | ArrayBuffer): Promise<PdfTextItem[]> {
  const pdfjs = await loadPdfjs()
  const data = file instanceof ArrayBuffer ? file : await file.arrayBuffer()
  // destroy() lives on the loading task, not the document.
  const task = pdfjs.getDocument({ data: new Uint8Array(data) })
  const doc = await task.promise
  const items: PdfTextItem[] = []
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      for (const raw of content.items) {
        const it = raw as { str?: string; transform?: number[] }
        if (!it.str || !it.transform) continue
        // Push each page below the last so a single y-sort gives reading order.
        items.push({
          str: it.str,
          transform: [...it.transform.slice(0, 5), it.transform[5] - p * PAGE_STRIDE],
        })
      }
      page.cleanup()
    }
  } finally {
    await task.destroy()
  }
  return items
}

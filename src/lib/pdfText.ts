// Browser-side PDF text extraction for the daily hotel reports.
//
// Split out from hotelReports.ts so the parsers themselves stay free of any
// pdfjs import: the same parsing code then runs unchanged in node (tests) and
// could run in Deno (a future Gmail-triggered edge function).
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PdfTextItem } from '@/lib/hotelReports'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Keeps pages in order once all items are sorted by y as one list. */
const PAGE_STRIDE = 100_000

export async function pdfTextItems(file: File | ArrayBuffer): Promise<PdfTextItem[]> {
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

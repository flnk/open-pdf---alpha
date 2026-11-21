import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createServer as createViteServer } from 'vite';
import { PdfDocument } from 'ts-pdf-edit';

const PORT = Number(process.env.PORT || 5173);
const MAX_BODY = 100 * 1024 * 1024;

// Шрифти-замінники Liberation метрично сумісні з Arial, Times і Courier та підтримують кирилицю.
const fontCache = new Map();
async function substituteFontFor(key) {
  const m = /^(sans|serif|mono)-(Regular|Bold|Italic|BoldItalic)$/.exec(String(key ?? ''));
  const [family, style] = m ? [m[1], m[2]] : ['sans', 'Regular'];
  const name = family === 'serif' ? 'Serif' : family === 'mono' ? 'Mono' : 'Sans';
  const file = `Liberation${name}-${style}.ttf`;
  if (!fontCache.has(file)) {
    fontCache.set(file, new Uint8Array(await readFile(new URL(`./public/fonts/${file}`, import.meta.url))));
  }
  return fontCache.get(file);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) throw new Error('PDF слишком большой (лимит 100 МБ).');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const vite = await createViteServer({
  configFile: './vite.config.ts',
  server: { middlewareMode: true },
  appType: 'spa',
});

const server = createHttpServer(async (req, res) => {
  if (req.url?.split('?')[0] !== '/api/rewrite-pdf') {
    vite.middlewares(req, res, (err) => {
      if (err) {
        console.error(err);
        res.statusCode = 500;
        res.end('Vite middleware error');
      }
    });
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Используй POST.' }));
    return;
  }

  let document;
  const strategies = [];
  try {
    const payload = await readJson(req);
    if (typeof payload.pdfBase64 !== 'string' || !Array.isArray(payload.edits)) {
      throw new Error('Некорректный запрос на редактирование PDF.');
    }
    const pdfBytes = new Uint8Array(Buffer.from(payload.pdfBase64, 'base64'));
    document = await PdfDocument.open(pdfBytes);

    for (const [i, edit] of payload.edits.entries()) {
      if (!Number.isInteger(edit.pageIndex) || edit.pageIndex < 0 || edit.pageIndex >= document.pageCount) {
        throw new Error(`Замена №${i + 1}: неверный номер страницы.`);
      }
      if (typeof edit.originalText !== 'string' || !edit.originalText || typeof edit.newText !== 'string') {
        throw new Error(`Замена №${i + 1}: некорректный текст.`);
      }
      if (edit.originalText === edit.newText) continue;

      const matches = (await document.searchText(edit.originalText, { pages: [edit.pageIndex] }))
        .filter((hit) => hit.pageIndex === edit.pageIndex && hit.text === edit.originalText);
      if (matches.length === 0) {
        throw new Error(`Страница ${edit.pageIndex + 1}: не удалось найти исходный текст «${edit.originalText}».`);
      }
      if (matches.length > 1) {
        throw new Error(`Страница ${edit.pageIndex + 1}: текст «${edit.originalText}» встречается несколько раз. Чтобы не изменить не тот фрагмент, замена остановлена.`);
      }

      const editor = document.getPage(edit.pageIndex).editor();
      const located = await editor.locate(matches[0]);
      if (!located.editable) {
        throw new Error(`Страница ${edit.pageIndex + 1}: этот фрагмент нельзя безопасно изменить (${located.reason}).`);
      }
      const report = await editor.rewriteText(located.located, edit.newText, {
        substituteFont: await substituteFontFor(edit.font),
      });
      strategies.push(report?.fontStrategy ?? 'unknown');
    }

    const { bytes } = await document.save();
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': bytes.byteLength,
      'Cache-Control': 'no-store',
      'X-OpenPDF-Font-Strategy': [...new Set(strategies)].join(','),
    });
    res.end(Buffer.from(bytes));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Неизвестная ошибка редактирования PDF.';
    console.error('[OpenPDF rewrite]', error);
    if (!res.headersSent) {
      res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message }));
    } else {
      res.end();
    }
  } finally {
    if (document) await document.close().catch(() => {});
  }
});

server.listen(PORT, () => {
  console.log(`OpenPDF доступен на http://localhost:${PORT}`);
});

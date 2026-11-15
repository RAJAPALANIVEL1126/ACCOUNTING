import type { Response } from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Report } from './reports';

/** Neutralise spreadsheet formula injection in text cells. */
const safeText = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
};
const csvCell = (s: string) => (/[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);

function headerLines(r: Report): string[] {
  const period = r.meta.asOf ? `As of ${r.meta.asOf}` : r.meta.from && r.meta.to ? `Period: ${r.meta.from} to ${r.meta.to}` : '';
  const filters = Object.entries(r.meta.filters).map(([k, v]) => `${k}: ${v}`).join('; ');
  return [
    r.meta.companyName,
    r.title,
    period,
    `Currency: ${r.meta.currency}`,
    `Accounting method: ${r.meta.basis}`,
    ...(filters ? [`Filters: ${filters}`] : []),
    `Generated: ${r.meta.generatedAt}`,
  ].filter(Boolean);
}

export function toCsv(r: Report): string {
  const lines: string[] = headerLines(r).map((l) => csvCell(safeText(l)));
  lines.push('');
  lines.push(r.columns.map((c) => csvCell(c.label)).join(','));
  const render = (row: Record<string, unknown>) =>
    r.columns.map((c) => csvCell(c.type === 'money' || c.type === 'number' ? String(row[c.key] ?? '') : safeText(row[c.key]))).join(',');
  for (const row of r.rows) lines.push(render(row));
  if (r.totals) lines.push(render(r.totals));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export async function toXlsx(r: Report): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Company Accounting Software';
  wb.created = new Date();
  const ws = wb.addWorksheet(r.title.slice(0, 31).replace(/[\\/*?:[\]]/g, ' '));
  for (const [i, l] of headerLines(r).entries()) {
    const row = ws.addRow([safeText(l)]);
    row.font = { bold: i < 2, size: i === 0 ? 14 : i === 1 ? 12 : 10 };
  }
  ws.addRow([]);
  const head = ws.addRow(r.columns.map((c) => c.label));
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F1E3D' } };
  });
  const add = (row: Record<string, unknown>, bold: boolean) => {
    const x = ws.addRow(
      r.columns.map((c) => {
        const v = row[c.key];
        if (c.type === 'money' || c.type === 'number') return v === '' || v === undefined || v === null ? null : Number(v);
        return safeText(v);
      }),
    );
    if (bold) x.font = { bold: true };
    return x;
  };
  for (const row of r.rows) add(row, Boolean(row._style));
  if (r.totals) {
    const t = add(r.totals, true);
    t.eachCell((cell) => {
      cell.border = { top: { style: 'thin' } };
    });
  }
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.type === 'money' ? 18 : c.key === 'description' || c.key === 'label' ? 44 : 20;
    if (c.type === 'money') col.numFmt = '#,##0.00;[Red]-#,##0.00';
    if (c.type === 'money' || c.type === 'number') col.alignment = { horizontal: 'right' };
  });
  if (r.note) {
    ws.addRow([]);
    ws.addRow([safeText('Note: ' + r.note)]).font = { italic: true, size: 9 };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const fmtMoney = (v: unknown) => {
  if (v === '' || v === null || v === undefined) return '';
  const n = String(v);
  const neg = n.startsWith('-');
  const [int, dec = '00'] = n.replace('-', '').split('.');
  return (neg ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec;
};

export function toPdf(r: Report): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const landscape = r.columns.length > 6;
    const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - 72;
    const lines = headerLines(r);
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#0F1E3D').text(lines[0], { width });
    doc.fontSize(12).text(lines[1], { width });
    doc.font('Helvetica').fontSize(8.5).fillColor('#444');
    for (const l of lines.slice(2)) doc.text(l, { width });
    doc.moveDown(0.8);

    // Column widths: text columns share the remaining space; money columns are fixed.
    const moneyW = landscape ? 62 : 90;
    const moneyCount = r.columns.filter((c) => c.type === 'money').length;
    const textCols = r.columns.length - moneyCount;
    const textW = Math.max(40, (width - moneyCount * moneyW) / Math.max(1, textCols));
    const widths = r.columns.map((c) => (c.type === 'money' ? moneyW : textW));
    const scale = width / widths.reduce((a, b) => a + b, 0);
    const w = widths.map((x) => x * scale);
    const fontSize = r.columns.length > 10 ? 6.2 : r.columns.length > 6 ? 7.2 : 9;
    const pad = 3;

    const drawRow = (cells: string[], opts: { bold?: boolean; fill?: string; color?: string } = {}) => {
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
      const heights = cells.map((c, i) => doc.heightOfString(c, { width: w[i] - pad * 2 }));
      const hgt = Math.max(...heights, fontSize) + pad * 2;
      if (doc.y + hgt > doc.page.height - 48) {
        doc.addPage();
        drawRow(r.columns.map((c) => c.label), { bold: true, fill: '#0F1E3D', color: '#FFFFFF' });
        doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize);
      }
      const y = doc.y;
      if (opts.fill) doc.rect(36, y, width, hgt).fill(opts.fill);
      doc.fillColor(opts.color ?? '#111');
      let x = 36;
      cells.forEach((c, i) => {
        doc.text(c, x + pad, y + pad, { width: w[i] - pad * 2, align: r.columns[i].type === 'money' || r.columns[i].type === 'number' ? 'right' : 'left' });
        x += w[i];
      });
      doc.moveTo(36, y + hgt).lineTo(36 + width, y + hgt).strokeColor('#DDDDDD').lineWidth(0.5).stroke();
      doc.y = y + hgt;
      doc.x = 36;
    };

    const cellsOf = (row: Record<string, unknown>) => r.columns.map((c) => (c.type === 'money' ? fmtMoney(row[c.key]) : String(row[c.key] ?? '')));
    drawRow(r.columns.map((c) => c.label), { bold: true, fill: '#0F1E3D', color: '#FFFFFF' });
    if (!r.rows.length) {
      doc.moveDown(0.5).font('Helvetica-Oblique').fontSize(9).fillColor('#666').text('No records for the selected period and filters.', 36);
    }
    for (const row of r.rows) drawRow(cellsOf(row), { bold: Boolean(row._style), fill: row._style === 'section' ? '#EEF1F6' : row._style === 'total' ? '#F6F7FA' : undefined });
    if (r.totals) drawRow(cellsOf(r.totals), { bold: true, fill: '#E6EAF2' });
    if (r.note) doc.moveDown(0.8).font('Helvetica-Oblique').fontSize(8).fillColor('#555').text('Note: ' + r.note, 36, undefined, { width });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font('Helvetica').fontSize(7.5).fillColor('#777');
      doc.text(`${r.meta.companyName} — ${r.title} — Page ${i + 1} of ${range.count}`, 36, doc.page.height - 30, { width, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

export async function sendReport(res: Response, r: Report, format: string) {
  const name = `${r.key}-${r.meta.asOf ?? `${r.meta.from}_${r.meta.to}`}`.replace(/[^A-Za-z0-9_.-]/g, '');
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    return res.send(toCsv(r));
  }
  if (format === 'xlsx') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.xlsx"`);
    return res.send(await toXlsx(r));
  }
  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
    return res.send(await toPdf(r));
  }
  return res.json({ data: r });
}

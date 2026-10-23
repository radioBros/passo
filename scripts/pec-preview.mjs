#!/usr/bin/env node
/**
 * PEC test tool — the exact email PASSO would send to SdI, WITHOUT sending it
 * to SdI.
 *
 * There is no SdI test environment reachable over PEC: anything that reaches
 * sdi01@pec.fatturapa.it is a real tax transmission. So PEC is tested by
 * producing the message and inspecting it — as an .eml file, or by sending it
 * to YOUR OWN mailbox. Any *.fatturapa.it recipient is refused.
 *
 *   # write the .eml only (no network)
 *   node --experimental-strip-types scripts/pec-preview.mjs --out invoice.eml
 *
 *   # send it to your own address through your PEC provider
 *   PEC_SMTP_HOST=smtps.pec.aruba.it PEC_SMTP_PORT=465 PEC_USER=you@pec.it PEC_PASSWORD=… \
 *   node --experimental-strip-types scripts/pec-preview.mjs --send --to you@pec.it
 *
 * Options:
 *   --invoice <file.json>  invoice in PASSO's model (default: a sample B2B invoice)
 *   --xml <file.xml>       an already-generated FatturaPA file instead
 *   --vat <IdCodice>       transmitter / seller VAT for the sample (default 01234567897)
 *   --prog <ProgressivoInvio>  default 00001
 *   --out <file.eml>       where to write the message (default pec-preview.eml)
 *   --send --to <address>  also send it, via PEC_SMTP_HOST/PORT, PEC_USER, PEC_PASSWORD
 *
 * The message comes from buildPecMessage() — the same function the PEC
 * channel uses to transmit — and the XML passes the same mandatory XSD gate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { buildPecMessage, estimateMessageBytes, PEC_MAX_BYTES, PEC_SMTP_TLS, SDI_FIRST_ADDRESS }
  from '../src/infra/channels/pec.ts';
import { InvoiceSchema } from '../src/domain/invoice/model.ts';
import { generateInvoiceXml, invoiceFileName } from '../src/domain/invoice/generator.ts';
import { validateInvoiceXml } from '../src/infra/render/xsd.ts';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const flag = (name) => args.includes(`--${name}`);
const fail = (m) => { console.error(`✖ ${m}`); process.exit(1); };

const vat = opt('vat', '01234567897');
const prog = opt('prog', '00001');
const meta = { transmitterCountry: 'IT', transmitterCode: vat, progressivoInvio: prog };

const sample = {
  documentType: 'TD01', number: `PEC-PREVIEW-${Date.now().toString(36)}`,
  date: new Date().toISOString().slice(0, 10), currency: 'EUR', format: 'FPR12',
  recipientCode: '0000000', recipientPec: 'cliente@pec.example.it',
  seller: { vatId: { country: 'IT', code: vat }, name: 'Fornitore di Prova S.r.l.', taxRegime: 'RF01',
            address: { street: 'Via Roma 1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' } },
  buyer: { vatId: { country: 'IT', code: '12345678903' }, name: 'Cliente di Prova S.p.A.',
           address: { street: 'Via Milano 2', postalCode: '00100', city: 'Roma', province: 'RM', country: 'IT' } },
  lines: [{ lineNumber: 1, description: 'Servizi di consulenza', unitPrice: '1000.00', totalPrice: '1000.00', vatRate: '22.00' }],
  summaries: [{ vatRate: '22.00', taxableAmount: '1000.00', taxAmount: '220.00' }],
};

let xml;
if (opt('xml')) {
  xml = readFileSync(opt('xml'), 'utf8');
} else {
  const raw = opt('invoice') ? JSON.parse(readFileSync(opt('invoice'), 'utf8')) : sample;
  const parsed = InvoiceSchema.safeParse(raw);
  if (!parsed.success) fail(`invoice is invalid:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  xml = generateInvoiceXml(parsed.data, meta);
}
const v = validateInvoiceXml(xml);
if (!v.valid) fail(`XML fails the official XSD:\n  ${v.errors.join('\n  ')}`);

const filename = invoiceFileName(meta, false);
const to = flag('send') ? opt('to') : SDI_FIRST_ADDRESS;
if (flag('send')) {
  if (!to) fail('--send needs --to <your address>');
  if (/fatturapa\.it\s*$/i.test(to)) fail(`refusing ${to}: that is SdI — a real tax transmission. Send to your own mailbox.`);
}
const from = process.env.PEC_USER ?? 'mittente@pec.example.it';
const message = buildPecMessage({ xml, filename }, from, to);

// Render the exact MIME message, without any network.
const built = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
  .sendMail(message);
const out = opt('out', 'pec-preview.eml');
writeFileSync(out, built.message);

// Read it back the way SdI's side would, and check what matters.
const mail = await simpleParser(built.message);
const att = mail.attachments ?? [];
const xmlAtt = att.find((a) => /\.xml(\.p7m)?$/i.test(a.filename ?? ''));
const est = estimateMessageBytes(Buffer.byteLength(xml, 'utf8'));
const checks = [
  ['exactly one attachment', att.length === 1],
  ['attachment named by the FatturaPA rule', /^[A-Z]{2}[A-Z0-9]{1,28}_[A-Za-z0-9]{1,10}\.xml(\.p7m)?$/.test(xmlAtt?.filename ?? '')],
  ['attachment name matches the file name', xmlAtt?.filename === filename],
  ['attachment is byte-identical to the generated XML', xmlAtt?.content.toString('utf8') === xml],
  ['XML passes the official XSD', v.valid],
  [`size within SdI's 30 MB (${built.message.length} bytes, est. ${est})`, built.message.length < PEC_MAX_BYTES],
];
console.log(`\nwrote ${out}`);
console.log(`  From:       ${message.from}\n  To:         ${message.to}${flag('send') ? '' : '   (what PASSO would use — NOT sent)'}`);
console.log(`  Subject:    ${message.subject}\n  Attachment: ${xmlAtt?.filename} (${xmlAtt?.contentType}, ${xmlAtt?.size} bytes)\n`);
for (const [what, ok] of checks) console.log(`  ${ok ? '✔' : '✖'} ${what}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);

if (flag('send')) {
  const { PEC_SMTP_HOST: host, PEC_SMTP_PORT: port = '465', PEC_PASSWORD: pass } = process.env;
  if (!host || !process.env.PEC_USER || !pass) fail('--send needs PEC_SMTP_HOST, PEC_USER and PEC_PASSWORD');
  const transport = nodemailer.createTransport({
    host, port: Number(port), ...PEC_SMTP_TLS, auth: { user: process.env.PEC_USER, pass },
  });
  try {
    const info = await transport.sendMail(message);
    console.log(`\n  ✔ sent to ${to} — Message-ID ${info.messageId}`);
    console.log('    Your provider will deliver it inside its signed PEC envelope; the');
    console.log('    message above is the inner postacert.eml.');
  } finally { transport.close(); }
}

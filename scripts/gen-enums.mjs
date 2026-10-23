#!/usr/bin/env node
// Regenerates src/shared/types/fatturapa-enums.ts from the bundled XSD.
// Enumerations are NEVER hand-copied: a wrong member does not fail loudly,
// it produces XML that SdI rejects per-invoice in production.
import { readFileSync, writeFileSync } from 'node:fs';

const XSD = 'assets/xsd/Schema_VFPR12_v1.2.3.xsd';
const OUT = 'src/shared/types/fatturapa-enums.ts';

const TYPES = {
  TipoDocumentoType: 'TipoDocumento', NaturaType: 'Natura',
  RegimeFiscaleType: 'RegimeFiscale', ModalitaPagamentoType: 'ModalitaPagamento',
  CondizioniPagamentoType: 'CondizioniPagamento', EsigibilitaIVAType: 'EsigibilitaIVA',
  FormatoTrasmissioneType: 'FormatoTrasmissione', TipoRitenutaType: 'TipoRitenuta',
  TipoCassaType: 'TipoCassa', SocioUnicoType: 'SocioUnico',
  StatoLiquidazioneType: 'StatoLiquidazione', TipoScontoMaggiorazioneType: 'TipoScontoMaggiorazione',
};

const xsd = readFileSync(XSD, 'utf8');
const lines = [
  `// GENERATED from ${XSD} — do not hand-edit.`,
  '// Regenerate: node scripts/gen-enums.mjs',
  '',
];
for (const [xsdType, name] of Object.entries(TYPES)) {
  const m = xsd.match(new RegExp(`<xs:simpleType name="${xsdType}">([\\s\\S]*?)</xs:simpleType>`));
  if (!m) { console.warn(`  skip ${xsdType} (not found)`); continue; }
  const vals = [...m[1].matchAll(/value="([^"]+)"/g)].map((v) => v[1]).filter((v) => !/^\d+$/.test(v));
  if (!vals.length) continue;
  lines.push(`export const ${name.toUpperCase()} = [`);
  lines.push('  ' + vals.map((v) => `'${v}'`).join(', ') + ',');
  lines.push('] as const;');
  lines.push(`export type ${name} = (typeof ${name.toUpperCase()})[number];`);
  lines.push('');
  console.log(`  ${name.padEnd(24)} ${String(vals.length).padStart(3)} values`);
}
writeFileSync(OUT, lines.join('\n'));
console.log(`\nwrote ${OUT}`);

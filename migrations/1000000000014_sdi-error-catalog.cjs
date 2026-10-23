/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * SdI rejection catalogue as REFERENCE DATA (NOTIF-014).
 *
 * The catalogue also ships as a TypeScript module, which is what the running
 * code reads — but it belongs in the database too, for the reasons the plan
 * gives: it is reference data rather than tenant data, so it carries no
 * `tenant_id` and no RLS, and an operator must be able to query it directly
 * (`SELECT * FROM sdi_error_catalog WHERE code = '00409'`) without booting the
 * application or reading an Italian-language PDF.
 *
 * Seeded here and versioned with the migration, so the row set that ships with
 * a release is pinned to that release. Regenerating from a newer AdE Elenco
 * means a NEW migration, never an edit to this one — an applied migration is
 * history, and rewriting it diverges fresh installs from deployed ones.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS sdi_error_catalog (
      code           TEXT PRIMARY KEY,
      description_it TEXT        NOT NULL,
      gloss_en       TEXT        NOT NULL,
      remedy         TEXT        NOT NULL,
      source         TEXT        NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    INSERT INTO sdi_error_catalog (code, description_it, gloss_en, remedy, source) VALUES
    ('00001', 'Nome file non valido', 'File naming or transport fault', 'resubmit', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00002', 'Nome file duplicato', 'File naming or transport fault', 'resubmit', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00003', 'Le dimensioni del file superano quelle ammesse', 'File exceeds the channel size limit', 'split', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00100', 'Certificato di firma scaduto', 'Digital signature rejected', 'signature', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00101', 'Certificato di firma revocato', 'Digital signature rejected', 'signature', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00102', 'La firma elettronica apposta al file non risulta valida', 'Digital signature rejected', 'signature', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00103', 'Alla firma elettronica apposta al file manca il riferimento temporale', 'Digital signature rejected', 'signature', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00104', 'La CA (Certification Authority) che ha emesso il certificato di firma non risulta nell’elenco delle CA affidabili', 'Digital signature rejected', 'signature', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00105', 'Il riferimento temporale associato alla firma elettronica apposta al file è successivo alla data di ricezione del file', 'Digital signature rejected', 'signature', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00106', 'File / archivio vuoto o corrotto', 'Digital signature rejected', 'signature', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00107', 'Il certificato di firma non è valido', 'Digital signature rejected', 'signature', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00200', 'File non conforme al formato (nella descrizione del messaggio è riportata l’indicazione puntuale della non conformità)', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00201', 'Non è possibile procedere con ulteriori controlli, perché gli errori di formato presenti nel file superano il massimo previsto (50)', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00300', '1.1.1.2 <IdCodice> non valido', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00301', '1.2.1.1.2 <IdCodice> non valido', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00302', '1.2.1.2 <CodiceFiscale> non valido', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00303', '1.3.1.1.2 <IdCodice> o 1.4.4.1.2 <IdCodice> non valido', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00304', '1.3.1.2 <CodiceFiscale> non valido', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00305', '1.4.1.1.2 <IdCodice> non valido', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00306', '1.4.1.2 <CodiceFiscale> non valido', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00311', '1.1.4 <CodiceDestinatario> non valido', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00312', '1.1.4 <CodiceDestinatario> non attivo', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00320', '1.2.1.1 <IdFiscaleIVA> e 1.2.1.2 <CodiceFiscale> non coerenti', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00321', '1.2.1.2 <CodiceFiscale> di soggetto non partecipante al gruppo IVA', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00322', '1.2.1.2 <CodiceFiscale> non presente a fronte di 1.2.1.1 <IdFiscaleIVA> di gruppo IVA', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00323', '1.2.1.1.2 <IdCodice> corrispondente a una partita IVA cessata da oltre 5 anni', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00324', '1.4.1.1 <IdFiscaleIVA> e 1.4.1.2 <CodiceFiscale> non coerenti', 'A party identifier is invalid', 'fix_identifiers', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00398', 'Codice Ufficio presente ed univocamente identificabile nell’anagrafica IPA di riferimento, in presenza di 1.1.4 <CodiceDestinatario> valorizzato con codice ufficio “Centrale”', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00399', 'CessionarioCommittente presente nell’anagrafica IPA di riferimento in presenza di 1.1.3 <FormatoTrasmissione> valorizzato a “FPR12”', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00400', '2.2.1.14 <Natura> non presente a fronte di 2.2.1.12 <AliquotaIVA> pari a zero', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00401', '2.2.1.14 <Natura> presente a fronte di 2.2.1.12 <AliquotaIVA> diversa da zero', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00403', '2.1.1.3 <Data> successiva alla data di ricezione', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00404', 'Fattura duplicata', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00409', 'Fattura duplicata nel lotto Nel caso in cui il documento trasmesso sia una nota di credito (<TipoDocumento> = TD04), la verifica tiene conto anche della tipologia di documento; pertanto è ammessa la presenza di due documenti aventi stesso cedente/prestatore, stesso anno e stesso numero solo qualora uno dei due sia di tipo TD04. Nel caso di fatture emesse secondo modalità e termini stabiliti con decreto ministeriale ai sensi dell''articolo 73 del DPR 633/72 e per le quali è stato valorizzato a “SI” l’elemento informativo <Art73> (situazione che consente l''emissione nello stesso anno di più documenti aventi stesso numero), la verifica di unicità viene effettuata secondo le regole precedenti ma tenendo conto della data completa e non solo dell’anno', 'SdI already holds this invoice', 'duplicate', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00411', '2.1.1.5 <DatiRitenuta> non presente a fronte di almeno un blocco 2.2.1 <DettaglioLinee> con 2.2.1.13 <Ritenuta> uguale a SI', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00413', '2.1.1.7.7 <Natura> non presente a fronte di 2.1.1.7.5 <AliquotaIVA> pari a zero', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00414', '2.1.1.7.7 <Natura> presente a fronte di 2.1.1.7.5 <Aliquota IVA> diversa da zero', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00415', '2.1.1.5 <DatiRitenuta> non presente a fronte di 2.1.1.7.6 <Ritenuta> uguale a SI', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00417', '1.4.1.1 <IdFiscaleIVA> e 1.4.1.2 <CodiceFiscale> non valorizzati (almeno uno dei due deve essere valorizzato)', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00418', '2.1.1.3 <Data> antecedente a 2.1.6.3 <Data>', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00419', '2.2.2 <DatiRiepilogo> non presente in corrispondenza di almeno un valore di 2.1.1.7.5 <AliquotaIVA> o 2.2.1.12 <AliquotaIVA>', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00420', '2.2.2.2 <Natura> con valore di tipo N6 a fronte di 2.2.2.7 <EsigibilitaIVA> uguale a S (scissione pagamenti)', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00421', '2.2.2.6 <Imposta> non calcolato secondo le regole definite nelle specifiche tecniche', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00422', '2.2.2.5 <ImponibileImporto> non calcolato secondo le regole definite nelle specifiche tecniche', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00423', '2.2.1.11 <PrezzoTotale> non calcolato secondo le regole definite nelle specifiche tecniche', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00424', '2.2.1.12 <AliquotaIVA> o 2.2.2.1< AliquotaIVA> o 2.1.1.7.5 <AliquotaIVA> non indicata in termini percentuali', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00425', '2.1.1.4 <Numero> non contenente caratteri numerici', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00427', '1.1.4 <CodiceDestinatario> di 7 caratteri non ammesso a fronte di 1.1.3 <FormatoTrasmissione> con valore FPA12 o 1.1.4 <CodiceDestinatario> di 6 caratteri non ammesso a fronte di 1.1.3 <FormatoTrasmissione> con valore FPR12 o FSM10', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00428', '1.1.3 <FormatoTrasmissione> non coerente con il valore dell’attributo VERSION', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00429', '2.2.2.2 <Natura> non presente a fronte di 2.2.2.1 <AliquotaIVA> pari a zero', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00430', '2.2.2.2 <Natura> presente a fronte di 2.2.2.1 <Aliquota IVA> diversa da zero', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00437', '2.1.1.8.2 <Percentuale> e 2.1.1.8.3 <Importo> non presenti a fronte di 2.1.1.8.1 <Tipo> valorizzato', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00438', '2.2.1.10.2 <Percentuale> e 2.2.1.10.3 <Importo> non presenti a fronte di 2.2.1.10.1 <Tipo> valorizzato', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00443', 'Non c’è corrispondenza tra i valori indicati nell’elemento 2.2.1.12 <AliquotaIVA> o 2.1.1.7.5 <AliquotaIVA> e quelli dell’elemento 2.2.2.1 <ALiquotaIVA>', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00444', 'Non c’è corrispondenza tra i valori indicati nell’elemento 2.2.1.14 <Natura> o 2.1.1.7.7 <Natura> e quelli dell’elemento 2.2.2.2 <Natura>', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00445', '(controllo in vigore dal primo gennaio 2021) - Non è più ammesso il valore generico N2, N3 o N6 come codice natura dell’operazione', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00471', 'Per il valore indicato nell’elemento 2.1.1.1 <TipoDocumento> il cedente/prestatore non può essere uguale al cessionario/committente', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00472', 'Per il valore indicato nell’elemento 2.1.1.1 <TipoDocumento> il cedente/prestatore deve essere uguale al cessionario/committente', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00473', 'Per il valore indicato nell’elemento 2.1.1.1 <TipoDocumento> il valore nell’elemento 1.2.1.1.1 <IdPaese> non è ammesso', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00474', 'Per il valore indicato nell’elemento 2.1.1.1 <TipoDocumento> non sono ammesse linee di dettaglio con l’elemento 2.2.1.12 <AliquotaIVA> contenente valore zero', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00475', 'Per il valore indicato nell’elemento 2.1.1.1 <TipoDocumento> deve essere presente l’elemento 1.4.1.1 <IdFiscaleIVA> del cessionario/committente', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00476', 'Gli elementi 1.2.1.1.1 <IdPaese> e 1.4.1.1.1 <IdPaese> non possono essere entrambi valorizzati con codice diverso da IT', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0'),
    ('00477', 'Fattura recante titolo di non imponibilità ai fini IVA ai sensi dell’art. 8, comma 1, lett. c) DPR 26 ottobre 1972, n. 633, con Dichiarazione d’intento invalidata', 'An invoice field is missing, malformed or inconsistent', 'fix_payload', 'Agenzia delle Entrate — Elenco dei controlli v2.0')
    ON CONFLICT (code) DO UPDATE
      SET description_it = EXCLUDED.description_it,
          gloss_en       = EXCLUDED.gloss_en,
          remedy         = EXCLUDED.remedy,
          source         = EXCLUDED.source;
  `);

  // Reference data: readable by everything, writable by nothing at runtime.
  pgm.sql('GRANT SELECT ON sdi_error_catalog TO passo_app;');
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS sdi_error_catalog;');
};

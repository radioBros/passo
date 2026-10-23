/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Enum-backed CHECK constraints for FatturaPA values (DB-018).
 *
 * These columns already carry validated values — zod checks them at the API
 * boundary. The constraint matters for everything that is NOT that boundary: a
 * worker writing a state, a migration backfilling a column, an operator running
 * an UPDATE by hand. A wrong TipoDocumento reaches SdI and comes back as an NS,
 * by which point the invoice is legally not issued and needs reissuing.
 *
 * Values are taken from the GENERATED enums (src/shared/types/fatturapa-enums.ts,
 * derived from the official XSD) and from the submission state machine, so they
 * cannot drift from what the code accepts. Note TipoDocumento has real gaps:
 * TD07–TD15 do not exist, while TD29 does.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_document_type_check;
    ALTER TABLE invoices ADD CONSTRAINT invoices_document_type_check
      CHECK (document_type IN ('TD01','TD02','TD03','TD04','TD05','TD06','TD16','TD17','TD18','TD19','TD20','TD21','TD22','TD23','TD24','TD25','TD26','TD27','TD28','TD29'));
  `);

  pgm.sql(`
    ALTER TABLE sellers DROP CONSTRAINT IF EXISTS sellers_tax_regime_check;
    ALTER TABLE sellers ADD CONSTRAINT sellers_tax_regime_check
      CHECK (tax_regime IN ('RF01','RF02','RF04','RF05','RF06','RF07','RF08','RF09','RF10','RF11','RF12','RF13','RF14','RF15','RF16','RF17','RF18','RF19','RF20'));
  `);

  pgm.sql(`
    ALTER TABLE sdi_submissions DROP CONSTRAINT IF EXISTS sdi_submissions_state_check;
    ALTER TABLE sdi_submissions ADD CONSTRAINT sdi_submissions_state_check
      CHECK (state IN ('queued','transforming','generating','signing','transmitting','transmitted','awaiting_delivery','delivered','undelivered_attested','accepted_by_pa','rejected_by_pa','rejected','failed'));
  `);

  // A channel name that is not a registered adapter can never be dispatched:
  // the submission would sit queued forever with no error anywhere.
  pgm.sql(`
    ALTER TABLE sdi_submissions DROP CONSTRAINT IF EXISTS sdi_submissions_channel_check;
    ALTER TABLE sdi_submissions ADD CONSTRAINT sdi_submissions_channel_check
      CHECK (channel IN ('mock','pec','invoicetronic','openapi'));
    ALTER TABLE channel_credentials DROP CONSTRAINT IF EXISTS channel_credentials_channel_check;
    ALTER TABLE channel_credentials ADD CONSTRAINT channel_credentials_channel_check
      CHECK (channel IN ('mock','pec','invoicetronic','openapi'));
  `);

  pgm.sql(`
    ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
    ALTER TABLE tenants ADD CONSTRAINT tenants_status_check
      CHECK (status IN ('active','suspended','deactivated'));
    ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_status_check;
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_status_check
      -- 'rotating' is a real state: the old key stays valid during the
      -- rotation overlap so a caller can redeploy without an outage.
      CHECK (status IN ('active','rotating','revoked','expired'));
    ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_environment_check;
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_environment_check
      CHECK (environment IN ('live','test'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices          DROP CONSTRAINT IF EXISTS invoices_document_type_check;
    ALTER TABLE sellers           DROP CONSTRAINT IF EXISTS sellers_tax_regime_check;
    ALTER TABLE sdi_submissions   DROP CONSTRAINT IF EXISTS sdi_submissions_state_check;
    ALTER TABLE sdi_submissions   DROP CONSTRAINT IF EXISTS sdi_submissions_channel_check;
    ALTER TABLE channel_credentials DROP CONSTRAINT IF EXISTS channel_credentials_channel_check;
    ALTER TABLE tenants           DROP CONSTRAINT IF EXISTS tenants_status_check;
    ALTER TABLE api_keys          DROP CONSTRAINT IF EXISTS api_keys_status_check;
    ALTER TABLE api_keys          DROP CONSTRAINT IF EXISTS api_keys_environment_check;
  `);
};

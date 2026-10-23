/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * Keep the vendor's own handle for a submission (`channel_ref`).
 *
 * An API vendor answers a submission with ITS identifier — OpenAPI.it returns
 * an invoice `uuid` — and every later receipt is keyed by that uuid. PASSO
 * stored neither it nor an IdentificativoSdI for such a submission, so no
 * receipt could ever be matched: every RC/NS/MC was quarantined as "no
 * correlation record matched" and the invoice stayed `transmitted` forever.
 *
 * Found by the first real sandbox round trip (2026-10-01). The sandbox also
 * showed why the uuid, not the receipt body, must be the key: simulated
 * receipts all carry the same placeholder IdentificativoSdI ("111").
 *
 * Looked up under the tenant's own RLS context — the webhook knows the tenant
 * from its token and the poller iterates per tenant — so the routing view and
 * its bypass role (D-16) are deliberately NOT widened.
 */
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE sdi_submissions ADD COLUMN IF NOT EXISTS channel_ref TEXT;');
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS sdi_submissions_channel_ref_uq
      ON sdi_submissions (tenant_id, channel, channel_ref)
      WHERE channel_ref IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP INDEX IF EXISTS sdi_submissions_channel_ref_uq;');
  pgm.sql('ALTER TABLE sdi_submissions DROP COLUMN IF EXISTS channel_ref;');
};

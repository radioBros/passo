/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * ProgressivoInvio allocation.
 *
 * The first implementation derived the next value from COUNT(*) of existing
 * submissions. That is wrong: an NS retry burns a value, and any deletion or
 * gap makes count+1 collide with a row that already exists. The unique
 * constraint caught it, but only after the transaction had done its work.
 *
 * Replaced with a per-transmitter counter row, incremented under an advisory
 * lock. The counter only ever moves forward, so gaps are irrelevant.
 */
exports.up = (pgm) => {
  pgm.createTable('progressivo_counters', {
    transmitter_id: { type: 'text', primaryKey: true },
    next_value: { type: 'bigint', notNull: true, default: 1 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  // Seed from existing data so an upgrade never re-issues a used value.
  pgm.sql(`
    INSERT INTO progressivo_counters (transmitter_id, next_value)
    SELECT transmitter_id, count(*) + 1 FROM sdi_submissions GROUP BY transmitter_id
    ON CONFLICT (transmitter_id) DO NOTHING;
  `);
  pgm.sql('GRANT SELECT, INSERT, UPDATE ON progressivo_counters TO passo_app;');
};

exports.down = (pgm) => { pgm.dropTable('progressivo_counters', { ifExists: true }); };

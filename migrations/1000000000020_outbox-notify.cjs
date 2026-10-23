/* eslint-disable camelcase */
exports.shorthands = undefined;

/**
 * NOTIFY on outbox insert (QUEUE-008).
 *
 * The relay polls every 200ms, which is correct but adds up to 200ms of latency
 * to every invoice. A NOTIFY lets it wake immediately.
 *
 * **Correctness must not depend on it.** `NOTIFY` is not delivered to a
 * disconnected listener and is not queued for one — a relay that was
 * reconnecting when the notification fired would never learn about the row. So
 * the poll remains the guarantee and this is purely a latency optimisation; the
 * relay must behave identically with the trigger removed.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION outbox_notify() RETURNS trigger AS $$
    BEGIN
      -- No payload: it would leak tenant identifiers into a channel any
      -- connected session can listen on, and the relay re-reads anyway.
      PERFORM pg_notify('passo_outbox', '');
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    DROP TRIGGER IF EXISTS outbox_notify_trigger ON outbox;
    CREATE TRIGGER outbox_notify_trigger
      AFTER INSERT ON outbox
      -- Per STATEMENT, not per row: a 100-row batch should wake the relay once.
      FOR EACH STATEMENT EXECUTE FUNCTION outbox_notify();
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS outbox_notify_trigger ON outbox;');
  pgm.sql('DROP FUNCTION IF EXISTS outbox_notify();');
};

import type { SdiChannelAdapter, SubmitInput, SubmitResult, PollResult } from './types.ts';
import { parseNotification, type ParsedNotification } from '../../domain/notification/parser.ts';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Mock SdI channel for development and tests.
 *
 * Emits real notification XML built from the official examples, so the parser
 * is exercised against the same shapes production will see.
 */
const FIXTURES = 'tests/fixtures/official';

export interface MockScenario {
  /** Which notification sequence to emit for the next submission. */
  sequence: Array<'RC' | 'NS' | 'MC' | 'NE' | 'DT' | 'AT'>;
}

export class MockChannel implements SdiChannelAdapter {
  // Always healthy: it has no dependency to be unhealthy about.
  health(): Promise<{ ok: boolean; checked: string }> {
    return Promise.resolve({ ok: true, checked: 'in-process, no external dependency' });
  }

  readonly name = 'mock';
  readonly capabilities = {
    serverSideSigning: true, pushNotifications: false, maxMessageBytes: 30 * 1024 * 1024,
  };

  /** The mock stands in for a signing vendor, so B2G flows can be exercised offline. */
  willSign(): boolean { return true; }

  private queue: ParsedNotification[] = [];
  private counter = 0;

  private scenario: MockScenario;
  constructor(scenario: MockScenario = { sequence: ['RC'] }) { this.scenario = scenario; }

  setScenario(s: MockScenario): void { this.scenario = s; }

  async submit(_input: SubmitInput): Promise<SubmitResult> {
    this.counter++;
    const id = String(1000 + this.counter);
    for (const type of this.scenario.sequence) {
      const f = `${FIXTURES}/IT01234567890_11111_${type}_001.xml`;
      if (!existsSync(f)) continue;
      const xml = readFileSync(f, 'utf8').replace(
        /<IdentificativoSdI>[^<]*<\/IdentificativoSdI>/,
        `<IdentificativoSdI>${id}</IdentificativoSdI>`,
      );
      this.queue.push(parseNotification(xml));
    }
    return { identificativoSdI: id, channelRef: `mock-${id}`, acceptedAt: new Date() };
  }

  async poll(): Promise<PollResult> {
    const notifications = this.queue;
    this.queue = [];
    return { notifications, poison: [] };
  }
}

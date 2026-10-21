/**
 * Test doubles for the DynamoDB stores that read a cancelled transaction (the turn store and the access store): a
 * document client whose `send` records each command and answers with `respond`, the cancellation the SDK throws, and
 * the numbered reservations the access-store tests use.
 */
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";

import type { AccessReservation } from "../src/lib/access-store";

/** A document client whose `send` records each command and answers with `respond(command)`; a throw rejects. */
export function fakeDoc<C = unknown>(respond: (command: C) => unknown = () => ({})) {
  const sent: C[] = [];
  return {
    sent,
    doc: {
      send: (command: C) => {
        sent.push(command);
        try {
          return Promise.resolve(respond(command));
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    } as never,
  };
}

/** A cancelled transaction as the SDK throws it, with one cancellation reason per code. */
export const cancelled = (...codes: string[]) =>
  new TransactionCanceledException({
    message: "Transaction cancelled",
    $metadata: {},
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

/** The n-th reservation of a test: a distinct request ID and username, for the clinic-local `day`. */
export const numberedReservation = (n: number, day = "2026-10-20"): AccessReservation => ({
  requestId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  username: `user-${String(n).padStart(8, "0")}`,
  day,
  accessExpiresAt: "2026-10-21T14:00:00Z",
});

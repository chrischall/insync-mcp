// Refill requests: ask the practice to refill one or more current
// medications. Confirm-gated (`defineWrite` + `registerWrite`): the practice
// receives the request and there is no withdraw through this server.
//
// The pick lists come off the refill page (verified live, read-only); the save
// is derived from `_bundles_Revamp_refillPrescriptionScript` and is UNVERIFIED
// on the wire — see docs/INSYNC-API.md. The portal's own success handler reads
// nothing from the response, so a 2xx is the only success signal; re-read the
// history (insync_list_refill_requests) to confirm.

import { z } from 'zod';
import { McpToolError, NonEmptyString, NumericIdString, defineWrite, registerWrite } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import type { InsyncClient } from '../client.js';
import { inputValue, selectOptions } from '../forms.js';
import { READ } from './_shared.js';
import { WRITE, renderWrite, sendOnce, writeDescription } from './_writes.js';

export interface RefillOptions {
  practice: string | undefined;
  medications: { medicationId: string; name: string }[];
  providers: { providerId: string; name: string }[];
}

/** The refill page's medication and provider pick lists. */
export function parseRefillOptions(html: string): RefillOptions {
  return {
    practice: inputValue(html, 'PracticeName'),
    medications: selectOptions(html, 'ddlRefillDrug').map((o) => ({ medicationId: o.value, name: o.text })),
    providers: selectOptions(html, 'ddlSearchPrimaryProvider').map((o) => ({
      providerId: o.value,
      name: o.text,
    })),
  };
}

/**
 * `SaveRefillRequest`'s body: jQuery's serialization of
 * `{ refillPrescripationList: [ {...} ] }`, keys in the portal script's order.
 * `DrugName` is the multi-select's caption (names joined `", "`) and
 * `MedicationIDs` its value (ids joined `","`).
 */
export function buildRefillForm(input: {
  drugNames: string[];
  medicationIds: string[];
  refills: number;
  reason: string;
  pharmacyName: string;
  pharmacyAddress: string;
  pharmacyPhone: string;
  providerId: string;
}): URLSearchParams {
  const row: [string, string][] = [
    ['DrugName', input.drugNames.join(', ')],
    ['NoOfRefills', String(input.refills)],
    ['ReasonForRefill', input.reason],
    ['PharmacyName', input.pharmacyName],
    ['PharmacyAddress', input.pharmacyAddress],
    ['PharmacyPhone', input.pharmacyPhone],
    ['ResourceId', input.providerId],
    ['MedicationIDs', input.medicationIds.join(',')],
  ];
  return new URLSearchParams(row.map(([k, v]) => [`refillPrescripationList[0][${k}]`, v]));
}

export function registerRefillTools(server: McpServer, client: InsyncClient): void {
  server.registerTool(
    'insync_get_refill_options',
    {
      description:
        'List what a refill request can name: the medications on file that can be refilled ' +
        '(with the medication id insync_request_refill takes) and the provider/group the request ' +
        'goes to. Changes nothing.',
      annotations: READ,
      inputSchema: z.object({}),
    },
    async () => renderWrite(parseRefillOptions(await client.getRefillForm())),
  );

  registerWrite(
    server,
    defineWrite({
      name: 'insync_request_refill',
      description: writeDescription(
        'Request a refill of one or more current medications from your practice (ids from ' +
          'insync_get_refill_options). The practice receives the request; this server cannot ' +
          'withdraw it. Check the result with insync_list_refill_requests.',
      ),
      annotations: WRITE,
      inputSchema: z.object({
        medication_ids: z
          .array(NumericIdString)
          .min(1)
          .describe('Medication ids to refill, from insync_get_refill_options.'),
        refills: z.number().int().min(1).max(99).describe('How many refills are needed.'),
        pharmacy_name: NonEmptyString.max(100).describe('Pharmacy name.'),
        pharmacy_phone: NonEmptyString.max(30).describe('Pharmacy phone number.'),
        pharmacy_address: z.string().max(150).optional().describe('Pharmacy address (optional).'),
        reason: z.string().max(1000).optional().describe('Reason for the refill (optional).'),
        provider_id: NumericIdString.optional().describe(
          'Who the request goes to, from insync_get_refill_options. Default: the only one offered.',
        ),
      }),
      async plan(args) {
        const options = parseRefillOptions(await client.getRefillForm());
        const meds = args.medication_ids.map((id) => {
          const med = options.medications.find((m) => m.medicationId === id);
          if (med === undefined) {
            throw new McpToolError(`Medication ${id} is not on your refill list.`, {
              hint: 'Use a medication id from insync_get_refill_options.',
            });
          }
          return med;
        });
        const listed = options.providers.map((p) => `${p.providerId} (${p.name})`).join(', ');
        let provider: RefillOptions['providers'][number] | undefined;
        if (args.provider_id !== undefined) {
          provider = options.providers.find((p) => p.providerId === args.provider_id);
          if (provider === undefined) {
            throw new McpToolError(`Provider ${args.provider_id} is not offered for refills.`, {
              hint: `Offered: ${listed || 'none'}.`,
            });
          }
        } else if (options.providers.length === 1) {
          provider = options.providers[0];
        } else if (options.providers.length === 0) {
          throw new McpToolError('The practice offers no provider to send a refill request to.', {
            hint: 'Ask the practice by message instead (insync_send_message).',
          });
        } else {
          throw new McpToolError('Several providers can take refill requests; pick one.', {
            hint: `Pass provider_id: ${listed}.`,
          });
        }
        const chosen = provider as RefillOptions['providers'][number];
        const form = buildRefillForm({
          drugNames: meds.map((m) => m.name),
          medicationIds: meds.map((m) => m.medicationId),
          refills: args.refills,
          reason: args.reason ?? '',
          pharmacyName: args.pharmacy_name,
          pharmacyAddress: args.pharmacy_address ?? '',
          pharmacyPhone: args.pharmacy_phone,
          providerId: chosen.providerId,
        });
        return {
          gate: {
            action: 'insync.request_refill',
            summary: `Request a refill of ${meds.map((m) => m.name).join(', ')} from ${chosen.name}`,
            account: undefined,
            request: {
              method: 'POST',
              path: 'RefillPrescription/SaveRefillRequest',
              body: Object.fromEntries(form),
            },
            willSend: {
              medications: meds.map((m) => m.name),
              refills: args.refills,
              to: chosen.name,
              pharmacy: { name: args.pharmacy_name, phone: args.pharmacy_phone, address: args.pharmacy_address },
              reason: args.reason,
            },
          },
          state: { form, practice: options.practice, medications: meds.map((m) => m.name) },
        };
      },
      async execute({ form, practice, medications }) {
        return sendOnce(
          async () => {
            await client.submitForm('RefillPrescription/SaveRefillRequest', form);
            return {
              requested: true,
              practice,
              medications,
              note: 'The portal reports success only by accepting the request. Confirm it appears ' +
                'with insync_list_refill_requests.',
            };
          },
          'refill request',
          'insync_list_refill_requests',
        );
      },
      render: renderWrite,
    }),
  );
}

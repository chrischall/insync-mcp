import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { InsyncClient } from '../client.js';
import { READ, asRecord, asRecordArray, tidy } from './_shared.js';
import { viewArg, viewResponse } from '../view.js';

export function registerDashboardTools(server: McpServer, client: InsyncClient): void {
  server.registerTool(
    'insync_get_counts',
    {
      description:
        'Get the patient dashboard badge counts: unread messages, medications, allergies, ' +
        'problems, lab results, immunizations, and pending patient forms and surveys.',
      annotations: READ,
      inputSchema: z.object({ view: viewArg() }),
    },
    async ({ view }) => {
      const raw = await client.getCounts();
      return viewResponse(view, raw, (data) => {
        const d = asRecordArray(asRecord(data).Dashboard)[0];
        if (d === undefined) return undefined;
        return tidy({
          unreadMessages: d.UnreadMessage,
          medications: d.Medications,
          allergies: d.Allergies,
          problems: d.Problems,
          labResults: d.LabResults,
          immunizations: d.Immunizations,
          medicalHistory: d.MedicalHistory,
          psychiatricHistory: d.PsychiatricHistory,
          healthMaintenance: d.HealthMaintenance,
          pendingForms: d.PendingPatientFormCount,
          pendingSurveys: d.PendingPatientSurveyFormCount,
          newForms: d.NewAdditionalFormCount,
          newTreatmentPlans: d.NewTreatementPlanCount,
          assessmentTools: d.AssessmentToolsCount,
          encounterNotes: d.EncounterNoteCount,
        });
      });
    },
  );

  server.registerTool(
    'insync_get_balance',
    {
      description:
        'Get the patient account balance: the amount owed (net due) and any credit balance.',
      annotations: READ,
      inputSchema: z.object({ view: viewArg() }),
    },
    async ({ view }) => {
      const raw = await client.getBalance();
      return viewResponse(view, raw, (data) => {
        const p = asRecordArray(asRecord(asRecord(data).Dashboard).PaymentSummaryModel)[0];
        if (p === undefined) return undefined;
        return tidy({
          netDue: p.NetDue,
          creditBalance: p.CreditBalance,
          hideUnappliedCredit: p.IsPatPorHideUnappliedCredit,
        });
      });
    },
  );
}

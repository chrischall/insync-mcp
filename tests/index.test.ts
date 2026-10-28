import { describe, expect, it } from 'vitest';
import { readToolRoster } from './_tools.js';

describe('tool roster', () => {
  it('registers exactly the expected read tools', () => {
    expect(readToolRoster().sort()).toEqual([
      'insync_download_attachment',
      'insync_download_document',
      'insync_get_appointment_calendar',
      'insync_get_balance',
      'insync_get_counts',
      'insync_get_message',
      'insync_get_profile',
      'insync_list_allergies',
      'insync_list_appointments',
      'insync_list_attachments',
      'insync_list_documents',
      'insync_list_forms',
      'insync_list_medications',
      'insync_list_messages',
      'insync_list_refill_requests',
      'insync_list_surveys',
    ]);
  });
});

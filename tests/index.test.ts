import { describe, expect, it } from 'vitest';
import { readToolRoster } from './_tools.js';

describe('tool roster', () => {
  it('registers exactly the expected tools', () => {
    expect(readToolRoster().sort()).toEqual([
      'insync_cancel_appointment',
      'insync_download_attachment',
      'insync_download_document',
      'insync_find_appointment_slots',
      'insync_get_appointment_calendar',
      'insync_get_balance',
      'insync_get_counts',
      'insync_get_message',
      'insync_get_profile',
      'insync_get_refill_options',
      'insync_list_allergies',
      'insync_list_appointments',
      'insync_list_attachments',
      'insync_list_documents',
      'insync_list_forms',
      'insync_list_medications',
      'insync_list_message_recipients',
      'insync_list_messages',
      'insync_list_refill_requests',
      'insync_list_surveys',
      'insync_reply_message',
      'insync_request_appointment',
      'insync_request_refill',
      'insync_send_message',
      'insync_upload_insurance_card',
    ]);
  });
});

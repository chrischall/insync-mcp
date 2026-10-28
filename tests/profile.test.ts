import { describe, expect, it } from 'vitest';
import { projectProfileScalars, registerProfileTools } from '../src/tools/profile.js';
import { capture, jsonOf, okJson, type FakeCall } from './_tools.js';

function rig(responder: (c: FakeCall) => ReturnType<typeof okJson>) {
  const { handlers } = capture(registerProfileTools, responder);
  return (name: string) => handlers.get(name)!;
}

describe('projectProfileScalars', () => {
  it('keeps demographic scalars and drops photos, lists, objects and credential keys', () => {
    const raw = {
      PatientDetail: {
        FirstName: 'Pat',
        LastName: 'Example',
        DOB: '01/01/1990',
        Age: 36,
        Active: true,
        Image: 'base64…',
        GenderList: [{ id: 1 }],
        Address: { line1: '1 Main St' },
        PasswordHash: 'HASH',
        PortalToken: 'TOK',
        MiddleName: '',
        Suffix: null,
      },
    };
    expect(projectProfileScalars(raw)).toEqual({
      FirstName: 'Pat',
      LastName: 'Example',
      DOB: '01/01/1990',
      Age: 36,
      Active: true,
    });
  });

  it('reports the top-level keys when PatientDetail is missing', () => {
    const out = projectProfileScalars({ Result: true, Other: 1 });
    expect(out.note).toMatch(/PatientDetail/);
    expect(out.topLevelKeys).toEqual(['Result', 'Other']);
  });
});

describe('insync_get_profile', () => {
  it('returns the sanitized scalars', async () => {
    const get = rig(() => okJson({ PatientDetail: { FirstName: 'Pat', Image: 'x', Nickname: 'P' } }));
    const out = jsonOf(await get('insync_get_profile')({}));
    expect(out).toEqual({ FirstName: 'Pat', Nickname: 'P' });
  });

  it('never emits the profile photo even on full', async () => {
    const get = rig(() => okJson({ PatientDetail: { FirstName: 'Pat', Image: 'PHOTOBYTES' } }));
    const res = await get('insync_get_profile')({ view: 'full' });
    expect(res.content[0]!.text).not.toContain('PHOTOBYTES');
  });
});

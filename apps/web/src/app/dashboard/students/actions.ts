'use server';

import { revalidatePath } from 'next/cache';
import { errorMessage, staffApi } from '@/lib/api';
import type { FormState } from '@/lib/utils';

export async function createStudentAction(_previous: FormState, formData: FormData): Promise<FormState> {
  try {
    await staffApi('/students', {
      method: 'POST',
      body: {
        code: String(formData.get('code') ?? '').trim(),
        firstName: String(formData.get('firstName') ?? '').trim(),
        lastName: String(formData.get('lastName') ?? '').trim(),
        grade: String(formData.get('grade') ?? '').trim(),
        section: String(formData.get('section') ?? '').trim() || undefined,
        guardians: [
          {
            name: String(formData.get('guardianName') ?? '').trim(),
            phone: String(formData.get('guardianPhone') ?? '').trim(),
            language: String(formData.get('language') ?? 'am'),
            isPrimary: true,
          },
        ],
      },
    });
  } catch (error) {
    return { error: errorMessage(error) };
  }
  revalidatePath('/dashboard/students');
  return { success: 'Student saved.' };
}

function parseStudentCsv(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw new Error('The file is empty');
  const header = (lines[0] ?? '').toLowerCase();
  const start = header.includes('firstname') || header.includes('code') ? 1 : 0;
  return lines.slice(start).map((line, index) => {
    const [code, firstName, lastName, grade, section, guardianName, guardianPhone, language] = line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, ''));
    if (!code || !firstName || !lastName || !grade || !guardianName || !guardianPhone) {
      throw new Error(`Row ${index + start + 1} is missing required columns`);
    }
    return {
      code,
      firstName,
      lastName,
      grade,
      section: section || undefined,
      guardians: [{ name: guardianName, phone: guardianPhone, language: language === 'en' ? 'en' : 'am', isPrimary: true }],
    };
  });
}

export async function importStudentsAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const file = formData.get('file');
  const pasted = String(formData.get('csv') ?? '');
  const text = file instanceof File && file.size > 0 ? await file.text() : pasted;
  let students;
  try {
    students = parseStudentCsv(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Could not read the CSV' };
  }
  try {
    const result = await staffApi<{ created: number; updated: number }>('/students/import', { method: 'POST', body: { students } });
    revalidatePath('/dashboard/students');
    return { success: `Imported ${result.created} new and ${result.updated} updated students.` };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

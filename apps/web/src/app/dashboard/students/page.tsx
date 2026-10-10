import type { Metadata } from 'next';
import { Pagination } from '@/components/pagination';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyRow, Table, Td, Th } from '@/components/ui/table';
import { Field, Input } from '@/components/ui/form';
import { type Paginated, staffApi } from '@/lib/api';
import { CreateStudentForm, ImportStudentsForm } from './student-forms';

export const metadata: Metadata = { title: 'Students' };

interface StudentRow {
  id: string;
  code: string;
  firstName: string;
  lastName: string;
  grade: string;
  section: string | null;
  isActive: boolean;
  guardians: { isPrimary: boolean; guardian: { name: string; phone: string } }[];
}

export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; search?: string; grade?: string }>;
}) {
  const query = await searchParams;
  const page = Number(query.page ?? '1') || 1;
  const students = await staffApi<Paginated<StudentRow>>('/students', {
    query: { page, pageSize: 25, search: query.search, grade: query.grade },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">Students</h1>
      <Card>
        <CardHeader title="Directory" />
        <form className="flex flex-wrap gap-3 px-5 py-3" method="get">
          <Field label="Search" htmlFor="search" className="min-w-48 flex-1">
            <Input id="search" name="search" defaultValue={query.search} placeholder="Name or code" />
          </Field>
          <Field label="Grade" htmlFor="grade" className="w-28">
            <Input id="grade" name="grade" defaultValue={query.grade} />
          </Field>
          <button type="submit" className="mt-6 text-sm font-semibold text-brand-700">
            Filter
          </button>
        </form>
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Class</Th>
              <Th>Primary guardian</Th>
            </tr>
          </thead>
          <tbody>
            {students.items.length === 0 ? <EmptyRow colSpan={4}>No students match.</EmptyRow> : null}
            {students.items.map((student) => {
              const guardian = student.guardians.find((link) => link.isPrimary)?.guardian ?? student.guardians[0]?.guardian;
              return (
                <tr key={student.id}>
                  <Td className="font-mono text-xs">{student.code}</Td>
                  <Td className="font-medium text-gray-900">
                    {student.firstName} {student.lastName}
                  </Td>
                  <Td>
                    {student.grade}
                    {student.section ? ` ${student.section}` : ''}
                  </Td>
                  <Td>
                    {guardian ? (
                      <>
                        {guardian.name}
                        <span className="block text-xs text-gray-500">{guardian.phone}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        <Pagination path="/dashboard/students" page={students.page} pageSize={students.pageSize} total={students.total} query={{ search: query.search, grade: query.grade }} />
      </Card>
      <Card>
        <CardHeader title="Add a student" />
        <CardBody>
          <CreateStudentForm />
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Import CSV" description="Up to 2,000 rows. Existing codes are updated." />
        <CardBody>
          <ImportStudentsForm />
        </CardBody>
      </Card>
    </div>
  );
}

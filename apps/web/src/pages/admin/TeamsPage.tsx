import { type TeamDto } from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, UsersRound } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Button, Card, CenteredSpinner, EmptyState, ErrorAlert, Field, Input, Modal, PageHeader, Table } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

function TeamModal({ team, onClose }: { team: TeamDto | 'new'; onClose(): void }) {
  const qc = useQueryClient();
  const isNew = team === 'new';
  const [name, setName] = useState(isNew ? '' : team.name);
  const [description, setDescription] = useState(isNew ? '' : (team.description ?? ''));
  const mutation = useMutation({
    mutationFn: () =>
      isNew
        ? api<TeamDto>('/teams', { method: 'POST', body: { name, description: description || null } })
        : api<TeamDto>(`/teams/${team.id}`, { method: 'PATCH', body: { name, description: description || null } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['teams'] });
      toast.success(isNew ? 'Team created.' : 'Team updated.');
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={isNew ? 'New team' : 'Edit team'}
      description="Teams own repositories. Developers and viewers only see their teams' repositories and tickets."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="team-form" loading={mutation.isPending}>
            {isNew ? 'Create team' : 'Save'}
          </Button>
        </>
      }
    >
      <form id="team-form" onSubmit={submit} className="space-y-4">
        <ErrorAlert error={mutation.error} />
        <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} />}</Field>
        <Field label="Description">{(id) => <Input id={id} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />}</Field>
      </form>
    </Modal>
  );
}

export function TeamsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const manage = can('teams:manage');
  const [editing, setEditing] = useState<TeamDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<TeamDto | null>(null);
  const query = useQuery({ queryKey: ['teams'], queryFn: () => api<TeamDto[]>('/teams') });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/teams/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['teams'] });
      void qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('Team deleted.');
      setDeleting(null);
    },
  });

  return (
    <>
      <PageHeader
        title="Teams"
        description="Group people and repositories by ownership."
        actions={
          manage && (
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New team
            </Button>
          )
        }
      />
      <Card>
        <ErrorAlert error={query.error} />
        {query.isLoading ? (
          <CenteredSpinner />
        ) : !query.data?.length ? (
          <EmptyState
            icon={<UsersRound className="size-5" />}
            title="No teams yet"
            description="Create a team for each group that owns repositories."
            action={manage && <Button onClick={() => setEditing('new')}>Create a team</Button>}
          />
        ) : (
          <Table head={['Team', 'Members', '']}>
            {query.data.map((t) => (
              <tr key={t.id}>
                <td className="px-4 py-3">
                  <div className="font-medium">{t.name}</div>
                  {t.description && <div className="text-xs text-slate-500 dark:text-slate-400">{t.description}</div>}
                </td>
                <td className="px-4 py-3">
                  {can('users:read') ? (
                    <Link to={`/admin/users?team=${t.id}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
                      {t.memberCount}
                    </Link>
                  ) : (
                    t.memberCount
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  {manage && (
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm" aria-label={`Edit ${t.name}`} icon={<Pencil className="size-4" />} onClick={() => setEditing(t)} />
                      <Button variant="ghost" size="sm" aria-label={`Delete ${t.name}`} icon={<Trash2 className="size-4 text-red-600" />} onClick={() => setDeleting(t)} />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing && <TeamModal key={editing === 'new' ? 'new' : editing.id} team={editing} onClose={() => setEditing(null)} />}
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.name ?? 'team'}?`}
        description="Members keep their accounts but lose access granted through this team."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => deleting && remove.mutate(deleting.id)}>
              Delete team
            </Button>
          </>
        }
      >
        <ErrorAlert error={remove.error} />
      </Modal>
    </>
  );
}

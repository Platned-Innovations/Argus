import { type SavedViewDto, type SavedViewPage } from '@argus/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Checkbox, ErrorAlert, Field, Input, Modal, Select } from './ui';

/** Query strings compare equal regardless of parameter order. */
function normalize(query: string): string {
  const p = new URLSearchParams(query);
  p.sort();
  return p.toString();
}

/** Pick, save and delete named filter sets for a list. */
export function SavedViews({ page, query, onApply }: { page: SavedViewPage; query: string; onApply(query: string): void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);
  const views = useQuery({ queryKey: ['saved-views', page], queryFn: () => api<SavedViewDto[]>('/saved-views', { query: { page } }) });
  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/saved-views/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('View deleted.');
      void qc.invalidateQueries({ queryKey: ['saved-views', page] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not delete the view.'),
  });

  const list = views.data ?? [];
  const current = list.find((v) => normalize(v.query) === normalize(query));
  const mine = list.filter((v) => v.mine);
  const shared = list.filter((v) => !v.mine);
  const canDelete = current && (current.mine || can('tickets:triage'));

  return (
    <div className="flex items-center gap-1">
      <Select
        className="w-auto max-w-56"
        aria-label="Saved views"
        value={current?.id ?? ''}
        onChange={(e) => {
          const v = list.find((x) => x.id === e.target.value);
          if (v) onApply(v.query);
        }}
      >
        <option value="">{list.length ? 'Saved views…' : 'No saved views'}</option>
        {mine.length > 0 && (
          <optgroup label="My views">
            {mine.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.shared ? ' (shared)' : ''}
              </option>
            ))}
          </optgroup>
        )}
        {shared.length > 0 && (
          <optgroup label="Shared">
            {shared.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.ownerName ? ` · ${v.ownerName}` : ''}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
      {canDelete ? (
        <Button variant="ghost" size="sm" aria-label={`Delete view ${current.name}`} title="Delete this view" loading={remove.isPending} onClick={() => remove.mutate(current.id)} icon={<Trash2 className="size-4" />} />
      ) : (
        <Button variant="ghost" size="sm" title="Save the current filters as a view" onClick={() => setSaving(true)} icon={<Bookmark className="size-4" />}>
          Save view
        </Button>
      )}
      {saving && <SaveViewModal page={page} query={query} canShare={can('tickets:triage')} onClose={() => setSaving(false)} />}
    </div>
  );
}

function SaveViewModal({ page, query, canShare, onClose }: { page: SavedViewPage; query: string; canShare: boolean; onClose(): void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const save = useMutation({
    mutationFn: () => api<SavedViewDto>('/saved-views', { method: 'POST', body: { page, name, query, shared } }),
    onSuccess: () => {
      toast.success('View saved.');
      void qc.invalidateQueries({ queryKey: ['saved-views', page] });
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title="Save view"
      description="Saves the current filters under a name. Anyone who opens a view still sees only what they have access to."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="save-view" loading={save.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="save-view"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <ErrorAlert error={save.error} />
        <Field label="Name">{(id) => <Input id={id} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus required />}</Field>
        {canShare && <Checkbox label="Share with everyone" description="Shared views appear in everyone's list of views." checked={shared} onChange={(e) => setShared(e.target.checked)} />}
      </form>
    </Modal>
  );
}
